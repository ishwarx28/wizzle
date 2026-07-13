use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstructionFilePayload {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGlobalSkillFilePayload {
    pub description: Option<String>,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGitEnvironmentPayload {
    pub available: bool,
    pub is_worktree: bool,
    pub status_available: bool,
    pub tracked_change_count: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectContextPayload {
    pub git_environment: AgentGitEnvironmentPayload,
    pub git_tracked_state: String,
    pub global_skill_files: Vec<AgentGlobalSkillFilePayload>,
    pub global_skills_dir: Option<String>,
    pub instruction_files: Vec<AgentInstructionFilePayload>,
    pub project_id: String,
    pub project_root: String,
    pub session_cache_dir: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAgentToolInput {
    pub arguments: String,
    /// When false, image file reads return an error instead of inline image data.
    #[serde(default = "default_image_capable")]
    pub image_capable: bool,
    #[serde(default)]
    pub manual_approval_granted: bool,
    pub project_id: String,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    /// Conversation turn that owns this tool call (background process linkage, #75).
    #[serde(default)]
    pub turn_id: Option<String>,
}

fn default_image_capable() -> bool {
    // Prefer explicit FE flag; default true preserves older callers.
    true
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolRunPayload {
    pub error: Option<String>,
    pub output: Option<String>,
    pub status: String,
}
