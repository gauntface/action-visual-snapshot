/* eslint-env node */
import path from 'path';
import os from 'os';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
import * as io from '@actions/io';
import * as Sentry from '@sentry/node';
import {RewriteFrames} from '@sentry/integrations';

import {generateImageGallery} from './util/generateImageGallery';
import {saveSnapshots} from './util/saveSnapshots';
import {downloadSnapshots} from './util/downloadSnapshots';
import {uploadToGcs} from './util/uploadToGcs';
import {getStorageClient} from './util/getStorageClient';
import {diffSnapshots} from './util/diffSnapshots';
import {retrieveBaseSnapshots} from './api/retrieveBaseSnapshots';
import {startBuild} from './api/startBuild';
import {finishBuild, BuildResults} from './api/finishBuild';
import {failBuild} from './api/failBuild';
import {getOSTags} from './util/osTags';
import {SENTRY_DSN} from './config';
import {Await} from './types';
import {getODiffOptionsFromWorkflowInputs} from './getODiffOptionsFromWorkflowInputs';
import {downloadOtherWorkflowArtifact} from './api/downloadOtherWorkflowArtifact';
import {SpanStatus} from '@sentry/tracing';
import {getLatestWorkflowRun} from './api/getLatestWorkflowRun';
import {getArtifactsFromWorkflowRuns} from './api/getArtifactsFromWorkflowRuns';

// https://sharp.pixelplumbing.com/install#worker-threads
require('sharp');

function getParallelismInput() {
  const input = core.getInput('parallelism');

  if (typeof input === 'string') {
    const parsed = parseInt(input, 10);

    if (isNaN(parsed)) {
      core.debug('Invalid parallelism input, defaulting to CPU count');
      return os.cpus().length;
    }

    return parsed;
  }

  core.debug('No parallelism input, defaulting to CPU count');
  return os.cpus().length;
}

if (process.env.NODE_ENV !== 'test' && os.platform() !== 'linux') {
  throw new Error('This action is only supported on Linux');
}

const parallelism = getParallelismInput();
const {owner, repo} = github.context.repo;
const token = core.getInput('github-token') || process.env.ACTION_GITHUB_TOKEN;
const octokit = token && github.getOctokit(token);
const {GITHUB_WORKSPACE, GITHUB_WORKFLOW} = process.env;
const pngGlob = '/**/*.png';
const shouldSaveOnly = core.getInput('save-only') || process.env.ACTION_SAVE_ONLY;

Sentry.init({
  dsn: SENTRY_DSN,
  integrations: [
    new RewriteFrames({root: __dirname || process.cwd()}),
    new Sentry.Integrations.Http({tracing: true}),
  ],
  release: process.env.VERSION,
  tracesSampleRate: 1.0,
  environment:
    process.env.GITHUB_ACTION_REF === 'main' ? 'production' : 'development',
});

Sentry.setContext('actionEnvironment', {
  repo: process.env.GITHUB_REPOSITORY,
  ref: process.env.GITHUB_REF,
  head_ref: process.env.GITHUB_HEAD_REF,
});

const originalCoreDebug = core.debug;

// @ts-ignore
core.debug = (message: string) => {
  Sentry.addBreadcrumb({
    category: 'console',
    message,
    level: Sentry.Severity.Debug,
  });
  originalCoreDebug(message);
};

function handleError(error: Error) {
  Sentry.captureException(error);
  core.setFailed(error.message);
}

function getGithubHeadRefInfo(): {headRef: string; headSha: string} {
  const workflowRunPayload = github.context.payload.workflow_run;
  const pullRequestPayload = github.context.payload.pull_request;
  const workflowRunPullRequest = workflowRunPayload?.pull_requests?.[0];

  const head_sha =
    pullRequestPayload?.head.sha ||
    workflowRunPullRequest?.head.sha ||
    workflowRunPayload?.head_sha ||
    github.context.sha ||
    process.env.GITHUB_HEAD_SHA;

  return {
    headRef:
      pullRequestPayload?.head.ref ||
      workflowRunPullRequest?.head.ref ||
      (workflowRunPayload?.head_branch &&
        `${workflowRunPayload?.head_repository?.full_name}/${workflowRunPayload?.head_branch}`) ||
      github.context.ref ||
      process.env.GITHUB_HEAD_REF,
    headSha: head_sha,
  };
}

async function attemptSaveSnapshot(snapshotPath: string, artifactName: string) {
  try {
    if (snapshotPath) {
      await saveSnapshots({
        artifactName,
        rootDirectory: snapshotPath,
      });
    }
  } catch (error) {
    console.log('Failed to save snapshot: ', error);
    handleError(error as Error);
  }
}

async function compareArtifacts(baseArtifactName: string, basePath: string, mergeArtifactName: string, mergeBasePath: string, workflowRunPayload: any, mergeBaseSha:any, octokit: any, diffOptions: any, resultsPath: string) {
  console.log(`Comparing '${baseArtifactName}' and '${mergeArtifactName}'`);

  const workflowRuns = await getLatestWorkflowRun(octokit, {
    owner,
    repo,
    workflow_id: `${workflowRunPayload?.name || GITHUB_WORKFLOW}.yml`,
    commit: mergeBaseSha as string,
  });
  if (!workflowRuns) {
    core.error(`Failed to find workflow runs.`);
    return;
  }

  const artifacts = await getArtifactsFromWorkflowRuns(octokit, {
    owner,
    repo,
    workflowRuns,
    artifactNames: [baseArtifactName, mergeArtifactName],
  });

  if (!artifacts[baseArtifactName]) {
    core.error(`Failed to find ${baseArtifactName}`);
    return;
  }
  if (!artifacts[mergeArtifactName]) {
    core.error(`Failed to find ${mergeArtifactName}`);
    return;
  }

  core.debug(`Downloading artifact ${baseArtifactName}...`);
  await downloadOtherWorkflowArtifact(octokit, {
    owner,
    repo,
    artifactId: artifacts[baseArtifactName].id,
    downloadPath: basePath,
  });

  core.debug(`Downloading artifact ${mergeArtifactName}...`);
  await downloadOtherWorkflowArtifact(octokit, {
    owner,
    repo,
    artifactId: artifacts[mergeArtifactName].id,
    downloadPath: mergeBasePath,
  });

  const {
    baseFiles,
    changedSnapshots,
    missingSnapshots,
    newSnapshots,
    terminationReason,
  } = await diffSnapshots({
    basePath,
    mergeBasePath,
    currentPath: mergeBasePath,
    outputPath: resultsPath,
    diffOptions,
    parallelism,
  });
}

async function run(): Promise<void> {
  const snapshotPath: string = core.getInput('snapshot-path');
  const artifactName = process.env.ACTION_ARTIFACT_NAME ||
    core.getInput('artifact-name');
  await attemptSaveSnapshot(snapshotPath, artifactName);
  if (shouldSaveOnly !== 'false') {
    return;
  }

  const resultsRootPath: string = core.getInput('results-path');
  const resultsPath = path.resolve(resultsRootPath, 'visual-snapshots-results');
  const basePath = path.resolve('/tmp/visual-snapshots-base');
  const mergeBasePath = path.resolve('/tmp/visual-snapshots-merge-base');

  const workflowRunPayload = github.context.payload.workflow_run;
  const pullRequestPayload = github.context.payload.pull_request;
  // We're only interested the first pull request... I'm not sure how there can be multiple
  // Forks do not have `pull_requests` populated...
  const workflowRunPullRequest = workflowRunPayload?.pull_requests?.[0];

  // TODO: Need a good merge base for forks as neither of the below values will exist (input not included)
  const mergeBaseSha: string =
    core.getInput('merge-base') ||
    pullRequestPayload?.base?.sha ||
    workflowRunPullRequest?.base.sha ||
    github.context.payload.before;

  // Get odiff options from workflow inputs
  const diffOptions = getODiffOptionsFromWorkflowInputs();
  await io.mkdirP(resultsPath);

  // NOTE: This is a bit of a cheat to introduce a new behavior without risk
  // of breaking previous behavior.
  const baseArtifactName = process.env.ACTION_BASE_ARTIFACT || core.getInput('base-artifact');
  const mergeArtifactName = process.env.ACTION_MERGE_ARTIFACT || core.getInput('merge-artifact');
  if (baseArtifactName && mergeArtifactName) {
    await compareArtifacts(
      baseArtifactName,
      basePath,
      mergeArtifactName,
      mergeBasePath,
      workflowRunPayload,
      mergeBaseSha,
      octokit,
      diffOptions,
      resultsPath);
    return;
  }

  throw new Error('Injected by Matt.');
}

const {headRef, headSha} = getGithubHeadRefInfo();

const transaction = Sentry.startTransaction({
  op: shouldSaveOnly !== 'false' ? 'save snapshots' : 'run',
  // This is the title field in Discover
  name: shouldSaveOnly !== 'false' ? 'save snapshots' : 'run',
  tags: {
    head_ref: headRef,
    head_sha: headSha,
    diffing_library: 'odiff',
    ...getOSTags(),
  },
});

// Note that we set the transaction as the span on the scope.
// This step makes sure that if an error happens during the lifetime of the transaction
// the transaction context will be attached to the error event
Sentry.configureScope(scope => {
  scope.setSpan(transaction);
});

run().then(() => {
  core.debug('Finishing the transaction.');
  transaction.finish();
});
