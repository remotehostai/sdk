// The predicted effects of the Issues ops the console makes (app backends
// design 4.3): create issue, state, priority, assignee, labels, project,
// title and description, comment, relation. Rows are atlas-core's
// SQLite-shaped images. Any other Issues op predicts nothing and shows when
// its `change` arrives.

import type { Effect, ViewReader } from "../overlay.js";

type Row = Record<string, unknown>;

function issuePatch(view: ViewReader, issue: string, patch: Row, at: string): Effect[] {
  const row = view.get("issue", issue);
  if (!row) return [];
  return [{ entity: "issue", id: issue, row: { ...row, ...patch, updated_at: at } }];
}

export function predictIssues(
  op: Row,
  view: ViewReader,
  at: string,
  subject: string | null,
): Effect[] {
  const s = (k: string) => op[k] as string;
  switch (op.op) {
    case "create_issue": {
      const id = s("id");
      if (!id) return [];
      const team = view.get("team", s("team"));
      const row: Row = {
        id,
        team_id: op.team,
        title: op.title,
        state_id: op.state,
        priority: op.priority ?? 0,
        assignee_id: op.assignee ?? null,
        project_id: op.project ?? null,
        milestone_id: op.milestone ?? null,
        parent_id: op.parent ?? null,
        due_date: op.due_date ?? null,
        estimate: op.estimate ?? null,
        creator_id: subject,
        // The service numbers the issue; until then it shows its team's key alone.
        identifier: team?.key ? `${String(team.key)}-` : "",
        number: 0,
        archived: 0,
        sort_order: 0,
        previous_identifiers: "[]",
        created_at: at,
        updated_at: at,
      };
      const labels = Array.isArray(op.labels) ? (op.labels as string[]) : [];
      return [
        { entity: "issue", id, row },
        ...labels.map((l) => ({
          entity: "issue_label",
          id: `${id}/${l}`,
          row: { issue_id: id, label_id: l },
        })),
      ];
    }
    case "set_issue_state":
      return issuePatch(view, s("issue"), { state_id: op.state }, at);
    case "set_issue_priority":
      return issuePatch(view, s("issue"), { priority: op.priority }, at);
    case "set_issue_assignee":
      return issuePatch(view, s("issue"), { assignee_id: op.assignee ?? null }, at);
    case "set_issue_project":
      return issuePatch(view, s("issue"), { project_id: op.project ?? null }, at);
    case "edit_issue_title":
      return issuePatch(view, s("issue"), { title: op.title }, at);
    case "edit_issue_description":
      return issuePatch(view, s("issue"), { description: op.description ?? null }, at);
    case "set_issue_label": {
      const id = `${s("issue")}/${s("label")}`;
      const link: Effect = op.on
        ? { entity: "issue_label", id, row: { issue_id: op.issue, label_id: op.label } }
        : { entity: "issue_label", id, row: null };
      return [link, ...issuePatch(view, s("issue"), {}, at)];
    }
    case "add_comment": {
      const id = s("id");
      if (!id) return [];
      return [
        {
          entity: "comment",
          id,
          row: {
            id,
            issue_id: op.issue,
            body: op.body,
            user_id: subject,
            created_at: at,
            local_edit: 0,
          },
        },
      ];
    }
    case "add_relation": {
      const id = s("id");
      if (!id) return [];
      return [
        {
          entity: "relation",
          id,
          row: { id, issue_id: op.issue, related_issue_id: op.related, type: op.kind },
        },
      ];
    }
    case "remove_relation":
      return [{ entity: "relation", id: s("relation"), row: null }];
    default:
      return [];
  }
}
