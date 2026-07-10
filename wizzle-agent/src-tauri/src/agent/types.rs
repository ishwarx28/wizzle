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
pub struct AgentProjectContextPayload {
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
    pub approval_token: Option<String>,
    pub arguments: String,
    /// When false, image file reads return an error instead of inline image data.
    #[serde(default = "default_image_capable")]
    pub image_capable: bool,
    pub project_id: String,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    /// Conversation turn that owns this tool call (background process linkage, #75).
    #[serde(default)]
    pub turn_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAgentToolApprovalInput {
    pub arguments: String,
    pub project_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolApprovalPayload {
    pub approved: bool,
    pub token: Option<String>,
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
