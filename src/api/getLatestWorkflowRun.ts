import {GetResponseDataTypeFromEndpointMethod} from '@octokit/types';
import * as github from '@actions/github';
import * as core from '@actions/core';

type Octokit = ReturnType<typeof github.getOctokit>;
type WorkflowRun = GetResponseDataTypeFromEndpointMethod<
  Octokit['rest']['actions']['listWorkflowRuns']
>['workflow_runs'][number];

export type GetLatestWorkflowRun = {
  owner: string;
  repo: string;
  workflow_id: string;
  commit: string;
};

/**
 * Get the workflow runs
 */
export async function getLatestWorkflowRun(
  octokit: Octokit,
  {
    owner,
    repo,
    workflow_id,
    commit,
  }: GetLatestWorkflowRun
): Promise<WorkflowRun[]|null> {
  core.startGroup(
    `getLatestWorkflowRun - workflow_id: ${workflow_id} commit: ${commit}`
  );

  const resp = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    // Below is typed incorrectly, it needs to be a string but typed as number
    workflow_id,
    status: 'success',

    // GitHub API treats `head_sha` with explicit `undefined` value differently
    // than when `head_sha` does not exist in object. Want the latter.
    ...(commit ? {head_sha: commit} : {}),
  });
  const workflowRuns = resp.data.workflow_runs;

  if (!workflowRuns.length) {
    core.warning(
      `Workflow ${workflow_id} not found for commit ${commit}`
    );
    core.endGroup();
    return null;
  }

  // Ensure we are only running on the head repo (i.e. no forks)
  const completedWorkflowRuns = workflowRuns.filter(
    workflowRun => workflowRun.head_repository.full_name === `${owner}/${repo}`
  );
  core.debug(`Found ${completedWorkflowRuns.length} completed workflow runs`);
  core.endGroup();
  return completedWorkflowRuns;
}
