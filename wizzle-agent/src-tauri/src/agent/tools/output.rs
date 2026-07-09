use serde_json::{json, Value};

use crate::agent::types::AgentToolRunPayload;

pub fn success(output: Value) -> AgentToolRunPayload {
    AgentToolRunPayload {
        error: None,
        output: Some(output.to_string()),
        status: "done".to_string(),
    }
}

pub fn error(message: String) -> AgentToolRunPayload {
    AgentToolRunPayload {
        error: Some(message.clone()),
        output: Some(
            json!({
                "ok": false,
                "error": message,
            })
            .to_string(),
        ),
        status: "error".to_string(),
    }
}

pub fn error_with_output(message: String, details: Value) -> AgentToolRunPayload {
    let output = match details {
        Value::Object(mut object) => {
            object.insert("error".to_string(), Value::String(message.clone()));
            object.insert("ok".to_string(), Value::Bool(false));
            Value::Object(object)
        }
        other => json!({
            "details": other,
            "error": message,
            "ok": false,
        }),
    };

    AgentToolRunPayload {
        error: Some(message),
        output: Some(output.to_string()),
        status: "error".to_string(),
    }
}
