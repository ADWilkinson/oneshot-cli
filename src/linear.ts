import type { OneshotConfig } from "./config";

const LINEAR_API = "https://api.linear.app/graphql";

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  comments: { nodes: Array<{ body: string; user: { name: string } | null }> };
}

const gql = async (config: OneshotConfig, query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
  if (!config.linearApiKey) {
    throw new Error("linearApiKey not set in ~/.oneshot/config.json");
  }

  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.linearApiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
};

export const isLinearUrl = (input: string): boolean => {
  return input.startsWith("https://linear.app/");
};

export const extractIssueId = (url: string): string => {
  const match = url.match(/\/issue\/([A-Z0-9]+-\d+)/);
  if (!match) {
    throw new Error(`could not extract issue ID from Linear URL: ${url}`);
  }
  return match[1];
};

export const fetchIssue = async (config: OneshotConfig, issueId: string): Promise<LinearIssue> => {
  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        state { name }
        comments {
          nodes {
            body
            user { name }
          }
        }
      }
    }
  `;

  const data = (await gql(config, query, { id: issueId })) as { issue: LinearIssue };
  return data.issue;
};

export const formatIssueAsTask = (issue: LinearIssue): string => {
  const parts = [`# ${issue.identifier}: ${issue.title}`];

  if (issue.description) {
    parts.push(`\n## Description\n${issue.description}`);
  }

  if (issue.comments.nodes.length > 0) {
    parts.push("\n## Comments");
    for (const comment of issue.comments.nodes) {
      const author = comment.user?.name ?? "system";
      parts.push(`\n**${author}:**\n${comment.body}`);
    }
  }

  return parts.join("\n");
};

export const moveToInReview = async (config: OneshotConfig, issueId: string): Promise<void> => {
  const teamQuery = `
    query GetIssueTeam($id: String!) {
      issue(id: $id) {
        id
        team {
          id
          states {
            nodes {
              id
              name
            }
          }
        }
      }
    }
  `;

  const teamData = (await gql(config, teamQuery, { id: issueId })) as {
    issue: { id: string; team: { id: string; states: { nodes: Array<{ id: string; name: string }> } } };
  };

  const inReviewState = teamData.issue.team.states.nodes.find(
    (s) => s.name.toLowerCase() === "in review"
  );

  if (!inReviewState) {
    throw new Error("could not find 'In Review' state in Linear team");
  }

  const mutation = `
    mutation UpdateIssue($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `;

  await gql(config, mutation, { id: teamData.issue.id, stateId: inReviewState.id });
};

export const addPrComment = async (config: OneshotConfig, issueId: string, prUrl: string): Promise<void> => {
  const query = `
    query GetIssueInternalId($id: String!) {
      issue(id: $id) {
        id
      }
    }
  `;

  const data = (await gql(config, query, { id: issueId })) as { issue: { id: string } };

  const mutation = `
    mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;

  await gql(config, mutation, { issueId: data.issue.id, body: `PR raised by oneshot: ${prUrl}` });
};
