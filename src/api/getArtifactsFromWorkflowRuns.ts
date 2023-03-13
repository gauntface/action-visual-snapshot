import {GetResponseDataTypeFromEndpointMethod} from '@octokit/types';
import * as core from '@actions/core';
import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;
type WorkflowRun = GetResponseDataTypeFromEndpointMethod<
  Octokit['rest']['actions']['listWorkflowRuns']
>['workflow_runs'][number];
type Artifact = GetResponseDataTypeFromEndpointMethod<
  Octokit['rest']['actions']['listWorkflowRunArtifacts']
>['artifacts'][number];

export type GetArtifactsFromWorkflowRuns = {
  owner: string;
  repo: string;
  workflowRuns: WorkflowRun[];
  artifactNames: string[];
};

export type GetArtifactsFromWorkflowRunsReturn = { [key: string]: Artifact};

/**
 * Fetch artifacts from a workflow run from a branch
 *
 * This is a bit hacky since GitHub Actions currently does not directly
 * support downloading artifacts from other workflows
 */
export async function getArtifactsFromWorkflowRuns(
  octokit: Octokit,
  {
    owner,
    repo,
    workflowRuns,
    artifactNames,
  }: GetArtifactsFromWorkflowRuns
): Promise<GetArtifactsFromWorkflowRunsReturn> {
  core.startGroup(
    `getArtifactsFromWorkflowRuns - artifactNames: ${artifactNames}`
  );
  const artifacts: { [key: string]: Artifact } = {};
  for (const artifactName of artifactNames) {
    for (const workflowRun of workflowRuns) {
      core.debug(`Checking artifacts for workflow run: ${workflowRun.html_url}`);

      const resp = await octokit.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: workflowRun.id,
      });
      const allArtifacts = resp.data.artifacts;
      if (!allArtifacts) {
        core.debug(
          `Unable to fetch artifacts for workflow: ${workflowRun.id}`
        );
        continue
      }

      let artifactData = null;
      for (const a of allArtifacts) {
        if (a.name === artifactName) {
          core.debug(`Found suitable artifact for ${a.name}: ${a.url}`);
          artifactData = a;
          break;
        }
      }
      if (artifactData) {
        artifacts[artifactName] = artifactData;
        break;
      }
    }
  }
  core.endGroup();
  return artifacts;
}
