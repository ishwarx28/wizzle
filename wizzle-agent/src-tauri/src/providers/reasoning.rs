use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};

use super::types::ProviderRequestFieldInput;

const MAX_REASONING_VARIANTS: usize = 32;
const MAX_VARIANT_INPUTS: usize = 16;
const MAX_VARIANT_PATCHES: usize = 32;
const MAX_REPLAY_CAPTURES: usize = 32;
const MAX_REPLAY_MATCHES_PER_EVENT: usize = 256;
const MAX_REASONING_ARRAY_INDEX: usize = 1024;
const INTERNAL_REPLAY_FIELD: &str = "__wizzle_reasoning_replay";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReasoningConfig {
    #[serde(alias = "default_variant_id")]
    pub default_variant_id: Option<String>,
    pub variants: Vec<ReasoningVariant>,
    pub replay: Option<ReasoningReplayRule>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningVariant {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub inputs: Vec<ReasoningInput>,
    #[serde(default)]
    pub request: Vec<ReasoningRequestPatch>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningInput {
    pub id: String,
    #[serde(rename = "type")]
    pub input_type: ReasoningInputType,
    #[serde(rename = "default")]
    pub default_value: Option<i64>,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningInputType {
    Integer,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningRequestPatch {
    pub operation: ReasoningPatchOperation,
    pub path: String,
    pub value: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningPatchOperation {
    Omit,
    Set,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningReplayRule {
    pub scope: ReasoningReplayScope,
    #[serde(default)]
    pub capture: Vec<ReasoningReplayCapture>,
    #[serde(default, alias = "preserve_exactly")]
    pub preserve_exactly: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningReplayScope {
    ActiveToolLoop,
    AllTurns,
    ServerManaged,
    ToolCallTurns,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningReplayCapture {
    #[serde(alias = "response_path")]
    pub response_path: String,
    #[serde(alias = "assistant_message_path")]
    pub assistant_message_path: String,
    #[serde(default)]
    pub operation: ReasoningReplayOperation,
    pub when: Option<ReasoningReplayCondition>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningReplayCondition {
    #[serde(alias = "response_path")]
    pub response_path: String,
    pub equals: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningReplayOperation {
    Append,
    #[default]
    Merge,
    Prepend,
    Set,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReasoningSelection {
    pub variant_id: String,
    #[serde(default)]
    pub inputs: BTreeMap<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayCapturePayload<'a> {
    assistant_message_path: &'a str,
    operation: &'a ReasoningReplayOperation,
    value: &'a Value,
}

fn normalized_identifier(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 80 {
        return Err(format!("{label} must be between 1 and 80 characters."));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!(
            "{label} may contain only letters, numbers, hyphens, and underscores."
        ));
    }
    Ok(value.to_string())
}

fn validate_pointer(path: &str, label: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.len() > 512 {
        return Err(format!("{label} must be a JSON pointer beginning with /."));
    }
    if path.split('/').count() > 33 {
        return Err(format!("{label} is too deeply nested."));
    }
    if pointer_segments(path).iter().any(|segment| {
        segment
            .parse::<usize>()
            .is_ok_and(|index| index > MAX_REASONING_ARRAY_INDEX)
    }) {
        return Err(format!(
            "{label} contains an array index above {MAX_REASONING_ARRAY_INDEX}."
        ));
    }
    Ok(())
}

fn validate_request_path(path: &str) -> Result<(), String> {
    validate_pointer(path, "Reasoning request path")?;
    let first = path.split('/').nth(1).unwrap_or_default();
    if matches!(
        first,
        "contents"
            | "messages"
            | "model"
            | "stream"
            | "system"
            | "systemInstruction"
            | "tool_choice"
            | "toolChoice"
            | "toolConfig"
            | "tools"
    ) {
        return Err(format!(
            "Reasoning request path /{first} is reserved by Wizzle."
        ));
    }
    Ok(())
}

pub fn validate_provider_request_fields(
    fields: &[ProviderRequestFieldInput],
) -> Result<(), String> {
    if fields.len() > MAX_VARIANT_PATCHES {
        return Err(format!(
            "A provider can define at most {MAX_VARIANT_PATCHES} custom request fields."
        ));
    }
    let mut paths = HashSet::new();
    for field in fields {
        validate_request_path(&field.path)?;
        if !paths.insert(field.path.as_str()) {
            return Err(format!(
                "Custom request path {} is listed more than once.",
                field.path
            ));
        }
    }
    Ok(())
}

pub fn validate_reasoning_config(
    config: Option<ModelReasoningConfig>,
) -> Result<Option<ModelReasoningConfig>, String> {
    let Some(mut config) = config else {
        return Ok(None);
    };
    if config.variants.is_empty() && config.replay.is_none() {
        return Ok(None);
    }
    if config.variants.len() > MAX_REASONING_VARIANTS {
        return Err(format!(
            "A model can define at most {MAX_REASONING_VARIANTS} reasoning variants."
        ));
    }

    let mut variant_ids = HashSet::new();
    for variant in &mut config.variants {
        variant.id = normalized_identifier(&variant.id, "Reasoning variant id")?;
        variant.label = variant.label.trim().to_string();
        if variant.label.is_empty() || variant.label.len() > 80 {
            return Err("Reasoning variant label must be between 1 and 80 characters.".to_string());
        }
        if !variant_ids.insert(variant.id.clone()) {
            return Err(format!(
                "Reasoning variant id {} is listed more than once.",
                variant.id
            ));
        }
        if variant.inputs.len() > MAX_VARIANT_INPUTS {
            return Err(format!(
                "Reasoning variant {} has too many inputs.",
                variant.id
            ));
        }
        if variant.request.len() > MAX_VARIANT_PATCHES {
            return Err(format!(
                "Reasoning variant {} has too many request patches.",
                variant.id
            ));
        }

        let mut input_ids = HashSet::new();
        for input in &mut variant.inputs {
            input.id = normalized_identifier(&input.id, "Reasoning input id")?;
            if !input_ids.insert(input.id.clone()) {
                return Err(format!(
                    "Reasoning input id {} is listed more than once in variant {}.",
                    input.id, variant.id
                ));
            }
            if input.min.zip(input.max).is_some_and(|(min, max)| min > max) {
                return Err(format!(
                    "Reasoning input {} has a minimum greater than its maximum.",
                    input.id
                ));
            }
            if input.default_value.is_none() {
                return Err(format!(
                    "Reasoning input {} requires a default integer.",
                    input.id
                ));
            }
            if input.default_value.is_some_and(|default| {
                input.min.is_some_and(|min| default < min)
                    || input.max.is_some_and(|max| default > max)
            }) {
                return Err(format!(
                    "Reasoning input {} has a default outside its allowed range.",
                    input.id
                ));
            }
        }

        for patch in &variant.request {
            validate_request_path(&patch.path)?;
            match patch.operation {
                ReasoningPatchOperation::Set if patch.value.is_none() => {
                    return Err(format!(
                        "Reasoning set patch {} in variant {} requires a value.",
                        patch.path, variant.id
                    ));
                }
                ReasoningPatchOperation::Omit if patch.value.is_some() => {
                    return Err(format!(
                        "Reasoning omit patch {} in variant {} must not include a value.",
                        patch.path, variant.id
                    ));
                }
                _ => {}
            }
        }
    }

    if let Some(default_variant_id) = config.default_variant_id.take() {
        let default_variant_id =
            normalized_identifier(&default_variant_id, "Default reasoning variant id")?;
        if !variant_ids.contains(&default_variant_id) {
            return Err(format!(
                "Default reasoning variant {default_variant_id} is not defined by this model."
            ));
        }
        config.default_variant_id = Some(default_variant_id);
    }

    if let Some(replay) = &mut config.replay {
        if replay.capture.len() > MAX_REPLAY_CAPTURES {
            return Err(format!(
                "A model can define at most {MAX_REPLAY_CAPTURES} reasoning replay captures."
            ));
        }
        if matches!(replay.scope, ReasoningReplayScope::ServerManaged) {
            replay.capture.clear();
        } else if replay.capture.is_empty() {
            return Err("Reasoning replay requires at least one capture rule.".to_string());
        }
        for capture in &mut replay.capture {
            capture.response_path = capture.response_path.trim().to_string();
            capture.assistant_message_path = capture.assistant_message_path.trim().to_string();
            validate_pointer(&capture.response_path, "Reasoning response path")?;
            validate_pointer(
                &capture.assistant_message_path,
                "Reasoning assistant-message path",
            )?;
            if capture.assistant_message_path == "/role"
                || capture.assistant_message_path.starts_with("/role/")
            {
                return Err(
                    "Reasoning replay cannot replace an assistant message role.".to_string()
                );
            }
            if let Some(condition) = &mut capture.when {
                condition.response_path = condition.response_path.trim().to_string();
                validate_pointer(
                    &condition.response_path,
                    "Reasoning replay condition response path",
                )?;
            }
        }
    }

    Ok(Some(config))
}

fn decode_pointer_segment(segment: &str) -> String {
    segment.replace("~1", "/").replace("~0", "~")
}

fn pointer_segments(path: &str) -> Vec<String> {
    path.split('/')
        .skip(1)
        .map(decode_pointer_segment)
        .collect()
}

fn set_pointer(target: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let segments = pointer_segments(path);
    if segments.is_empty() {
        return Err("A reasoning JSON pointer cannot target the document root.".to_string());
    }

    let mut current = target;
    for (index, segment) in segments.iter().enumerate() {
        let is_last = index + 1 == segments.len();
        if is_last {
            match current {
                Value::Object(object) => {
                    object.insert(segment.clone(), value);
                    return Ok(());
                }
                Value::Array(array) => {
                    if segment == "-" {
                        array.push(value);
                        return Ok(());
                    }
                    let array_index = segment.parse::<usize>().map_err(|_| {
                        format!("Reasoning path segment {segment} is not a valid array index.")
                    })?;
                    if array_index > array.len() {
                        return Err(format!(
                            "Reasoning path array index {array_index} is out of bounds."
                        ));
                    }
                    if array_index == array.len() {
                        array.push(value);
                    } else {
                        array[array_index] = value;
                    }
                    return Ok(());
                }
                _ => {
                    return Err(format!(
                        "Reasoning path {} crosses a non-container value.",
                        path
                    ));
                }
            }
        }

        let next_is_array =
            segments[index + 1] == "-" || segments[index + 1].parse::<usize>().is_ok();
        match current {
            Value::Object(object) => {
                current = object.entry(segment.clone()).or_insert_with(|| {
                    if next_is_array {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Map::new())
                    }
                });
            }
            Value::Array(array) => {
                let array_index = segment.parse::<usize>().map_err(|_| {
                    format!("Reasoning path segment {segment} is not a valid array index.")
                })?;
                while array.len() <= array_index {
                    array.push(Value::Null);
                }
                if array[array_index].is_null() {
                    array[array_index] = if next_is_array {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(Map::new())
                    };
                }
                current = &mut array[array_index];
            }
            _ => {
                return Err(format!(
                    "Reasoning path {} crosses a non-container value.",
                    path
                ));
            }
        }
    }
    Ok(())
}

pub fn apply_provider_request_fields(
    body: &mut Value,
    fields: &[ProviderRequestFieldInput],
) -> Result<(), String> {
    validate_provider_request_fields(fields)?;
    for field in fields {
        set_pointer(body, &field.path, field.value.clone())?;
    }
    Ok(())
}

fn omit_pointer(target: &mut Value, path: &str) -> Result<(), String> {
    let segments = pointer_segments(path);
    let Some((last, parents)) = segments.split_last() else {
        return Err("A reasoning JSON pointer cannot target the document root.".to_string());
    };
    let mut current = target;
    for segment in parents {
        match current {
            Value::Object(object) => {
                let Some(next) = object.get_mut(segment) else {
                    return Ok(());
                };
                current = next;
            }
            Value::Array(array) => {
                let Ok(index) = segment.parse::<usize>() else {
                    return Ok(());
                };
                let Some(next) = array.get_mut(index) else {
                    return Ok(());
                };
                current = next;
            }
            _ => return Ok(()),
        }
    }
    match current {
        Value::Object(object) => {
            object.remove(last);
        }
        Value::Array(array) => {
            if let Ok(index) = last.parse::<usize>() {
                if index < array.len() {
                    array.remove(index);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn substitute_input_value(
    value: &Value,
    inputs: &BTreeMap<String, Value>,
) -> Result<Value, String> {
    if let Some(input_id) = value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("$input"))
        .and_then(Value::as_str)
    {
        return inputs
            .get(input_id)
            .cloned()
            .ok_or_else(|| format!("Reasoning input {input_id} is required."));
    }
    if let Some(text) = value.as_str() {
        if let Some(input_id) = text
            .strip_prefix("${")
            .and_then(|value| value.strip_suffix('}'))
        {
            return inputs
                .get(input_id)
                .cloned()
                .ok_or_else(|| format!("Reasoning input {input_id} is required."));
        }
    }
    match value {
        Value::Array(values) => values
            .iter()
            .map(|value| substitute_input_value(value, inputs))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| Ok((key.clone(), substitute_input_value(value, inputs)?)))
            .collect::<Result<Map<_, _>, String>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

fn validate_selection_inputs(
    variant: &ReasoningVariant,
    selection: &ProviderReasoningSelection,
) -> Result<(), String> {
    let definitions = variant
        .inputs
        .iter()
        .map(|input| (input.id.as_str(), input))
        .collect::<BTreeMap<_, _>>();
    for input_id in selection.inputs.keys() {
        if !definitions.contains_key(input_id.as_str()) {
            return Err(format!(
                "Reasoning variant {} does not define input {}.",
                variant.id, input_id
            ));
        }
    }
    for input in &variant.inputs {
        let Some(value) = selection.inputs.get(&input.id) else {
            return Err(format!("Reasoning input {} is required.", input.id));
        };
        match input.input_type {
            ReasoningInputType::Integer => {
                let Some(value) = value.as_i64() else {
                    return Err(format!("Reasoning input {} must be an integer.", input.id));
                };
                if input.min.is_some_and(|min| value < min)
                    || input.max.is_some_and(|max| value > max)
                {
                    return Err(format!(
                        "Reasoning input {} is outside its allowed range.",
                        input.id
                    ));
                }
            }
        }
    }
    Ok(())
}

pub fn apply_reasoning_selection(
    body: &mut Value,
    config: Option<&ModelReasoningConfig>,
    selection: Option<&ProviderReasoningSelection>,
) -> Result<(), String> {
    let (Some(config), Some(selection)) = (config, selection) else {
        return Ok(());
    };
    let variant_id = selection.variant_id.trim();
    if variant_id.is_empty() {
        return Ok(());
    }
    let variant = config
        .variants
        .iter()
        .find(|variant| variant.id == variant_id)
        .ok_or_else(|| format!("The selected reasoning variant {variant_id} is unavailable."))?;
    validate_selection_inputs(variant, selection)?;

    for patch in &variant.request {
        match patch.operation {
            ReasoningPatchOperation::Omit => omit_pointer(body, &patch.path)?,
            ReasoningPatchOperation::Set => {
                let value = substitute_input_value(
                    patch
                        .value
                        .as_ref()
                        .ok_or_else(|| "A reasoning set patch is missing its value.".to_string())?,
                    &selection.inputs,
                )?;
                set_pointer(body, &patch.path, value)?;
            }
        }
    }
    Ok(())
}

fn merge_value(target: &mut Value, incoming: Value) {
    match (target, incoming) {
        (Value::Object(target), Value::Object(incoming)) => {
            for (key, value) in incoming {
                if let Some(existing) = target.get_mut(&key) {
                    merge_value(existing, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (Value::Array(target), Value::Array(incoming)) => target.extend(incoming),
        (Value::String(target), Value::String(incoming)) => target.push_str(&incoming),
        (target, incoming) => *target = incoming,
    }
}

fn replay_sequence(value: Value) -> Vec<Value> {
    match value {
        Value::Array(values) => values,
        value => vec![value],
    }
}

fn replay_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Array(values) => {
            let mut combined = String::new();
            for value in values {
                match value {
                    Value::String(value) => combined.push_str(value),
                    Value::Null => {}
                    _ => return None,
                }
            }
            Some(combined)
        }
        _ => None,
    }
}

fn replay_seed(value: Value) -> Value {
    replay_string(&value)
        .map(Value::String)
        .unwrap_or_else(|| Value::Array(replay_sequence(value)))
}

fn apply_ordered_replay_value(
    message: &mut Value,
    path: &str,
    operation: &ReasoningReplayOperation,
    value: Value,
) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let Some(existing) = message.pointer_mut(path) else {
        return set_pointer(message, path, replay_seed(value));
    };
    if existing.is_null() {
        *existing = replay_seed(value);
        return Ok(());
    }
    if !existing.is_string() {
        if let Some(normalized) = replay_string(existing) {
            *existing = Value::String(normalized);
        }
    }
    if let Some(existing) = existing.as_str().map(str::to_string) {
        let incoming = replay_string(&value).ok_or_else(|| {
            format!("Reasoning replay path {path} cannot mix string and array values.")
        })?;
        let combined = if matches!(operation, ReasoningReplayOperation::Prepend) {
            format!("{incoming}{existing}")
        } else {
            format!("{existing}{incoming}")
        };
        return set_pointer(message, path, Value::String(combined));
    }
    if let Some(array) = existing.as_array_mut() {
        let values = replay_sequence(value);
        if matches!(operation, ReasoningReplayOperation::Prepend) {
            array.splice(0..0, values);
        } else {
            array.extend(values);
        }
        return Ok(());
    }
    Err(format!(
        "Reasoning replay path {path} must target a string or array for append or prepend."
    ))
}

fn apply_replay_value(
    message: &mut Value,
    path: &str,
    operation: &ReasoningReplayOperation,
    value: Value,
) -> Result<(), String> {
    match operation {
        ReasoningReplayOperation::Set => set_pointer(message, path, value),
        ReasoningReplayOperation::Merge => {
            if let Some(existing) = message.pointer_mut(path) {
                merge_value(existing, value);
                Ok(())
            } else {
                set_pointer(message, path, value)
            }
        }
        ReasoningReplayOperation::Append | ReasoningReplayOperation::Prepend => {
            apply_ordered_replay_value(message, path, operation, value)
        }
    }
}

pub fn apply_message_replay(source: &Value, target: &mut Value) -> Result<(), String> {
    let Some(entries) = source.get(INTERNAL_REPLAY_FIELD).and_then(Value::as_array) else {
        return Ok(());
    };
    for entry in entries {
        let path = entry
            .get("assistantMessagePath")
            .and_then(Value::as_str)
            .ok_or_else(|| "Stored reasoning replay is missing its assistant path.".to_string())?;
        validate_pointer(path, "Stored reasoning assistant-message path")?;
        let operation = serde_json::from_value::<ReasoningReplayOperation>(
            entry
                .get("operation")
                .cloned()
                .unwrap_or_else(|| Value::String("merge".into())),
        )
        .map_err(|_| "Stored reasoning replay has an invalid operation.".to_string())?;
        let value = entry
            .get("value")
            .cloned()
            .ok_or_else(|| "Stored reasoning replay is missing its value.".to_string())?;
        apply_replay_value(target, path, &operation, value)?;
    }
    Ok(())
}

pub fn strip_and_apply_openai_message_replay(body: &mut Value) -> Result<(), String> {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for message in messages {
        let source = message.clone();
        if let Some(object) = message.as_object_mut() {
            object.remove(INTERNAL_REPLAY_FIELD);
        }
        apply_message_replay(&source, message)?;
        if let Some(reasoning_content) = message.get_mut("reasoning_content") {
            if let Some(normalized) = replay_string(reasoning_content) {
                *reasoning_content = Value::String(normalized);
            } else if reasoning_content.is_array() {
                return Err(
                    "Stored reasoning_content must contain text rather than structured values."
                        .to_string(),
                );
            }
        }
        if message.get("role").and_then(Value::as_str) == Some("assistant")
            && message.get("content").is_some_and(Value::is_null)
        {
            message["content"] = Value::String(String::new());
        }
    }
    Ok(())
}

fn encode_pointer_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn capture_path_matches<'a>(
    current: &'a Value,
    segments: &[String],
    wildcards: &mut Vec<String>,
    matches: &mut Vec<(&'a Value, Vec<String>)>,
    overflowed: &mut bool,
) {
    if *overflowed {
        return;
    }
    if matches.len() >= MAX_REPLAY_MATCHES_PER_EVENT {
        *overflowed = true;
        return;
    }
    let Some((segment, rest)) = segments.split_first() else {
        matches.push((current, wildcards.clone()));
        return;
    };
    if segment == "*" {
        match current {
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    wildcards.push(index.to_string());
                    capture_path_matches(value, rest, wildcards, matches, overflowed);
                    wildcards.pop();
                    if *overflowed {
                        break;
                    }
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    wildcards.push(key.clone());
                    capture_path_matches(value, rest, wildcards, matches, overflowed);
                    wildcards.pop();
                    if *overflowed {
                        break;
                    }
                }
            }
            _ => {}
        }
        return;
    }
    match current {
        Value::Array(values) => {
            if let Ok(index) = segment.parse::<usize>() {
                if let Some(value) = values.get(index) {
                    capture_path_matches(value, rest, wildcards, matches, overflowed);
                }
            }
        }
        Value::Object(values) => {
            if let Some(value) = values.get(segment) {
                capture_path_matches(value, rest, wildcards, matches, overflowed);
            }
        }
        _ => {}
    }
}

fn resolve_path_template(path: &str, payload: &Value, wildcards: &[String]) -> Option<String> {
    let mut output = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('{') {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 1..];
        let end = after_start.find('}')?;
        let selector = &after_start[..end];
        if let Some(index) = selector
            .strip_prefix('$')
            .and_then(|value| value.parse::<usize>().ok())
        {
            output.push_str(&encode_pointer_segment(wildcards.get(index)?));
        } else {
            let replacement = payload.pointer(selector)?;
            if let Some(value) = replacement.as_str() {
                output.push_str(&encode_pointer_segment(value));
            } else if replacement.is_number() {
                output.push_str(&replacement.to_string());
            } else {
                return None;
            }
        }
        rest = &after_start[end + 1..];
    }
    output.push_str(rest);
    Some(output)
}

pub fn capture_replay_payloads(
    payload: &Value,
    config: Option<&ModelReasoningConfig>,
) -> Result<Vec<String>, String> {
    let Some(replay) = config.and_then(|config| config.replay.as_ref()) else {
        return Ok(Vec::new());
    };
    if matches!(replay.scope, ReasoningReplayScope::ServerManaged) {
        return Ok(Vec::new());
    }
    let mut captures = Vec::new();
    for capture in &replay.capture {
        if capture.when.as_ref().is_some_and(|condition| {
            payload.pointer(&condition.response_path) != Some(&condition.equals)
        }) {
            continue;
        }
        let mut matches = Vec::new();
        let mut overflowed = false;
        capture_path_matches(
            payload,
            &pointer_segments(&capture.response_path),
            &mut Vec::new(),
            &mut matches,
            &mut overflowed,
        );
        if overflowed {
            return Err(format!(
                "Provider returned more than {MAX_REPLAY_MATCHES_PER_EVENT} reasoning replay values in one event."
            ));
        }
        for (value, wildcards) in matches {
            if value.is_null() {
                continue;
            }
            let Some(path) =
                resolve_path_template(&capture.assistant_message_path, payload, &wildcards)
            else {
                continue;
            };
            validate_pointer(&path, "Resolved reasoning assistant-message path")?;
            let serialized = serde_json::to_string(&ReplayCapturePayload {
                assistant_message_path: &path,
                operation: &capture.operation,
                value,
            })
            .map_err(|_| "Could not capture provider reasoning replay metadata.".to_string())?;
            captures.push(serialized);
        }
    }
    Ok(captures)
}

pub fn serialize_reasoning_config(
    config: Option<&ModelReasoningConfig>,
) -> Result<Option<String>, String> {
    config
        .map(|config| {
            serde_json::to_string(config)
                .map_err(|_| "Could not save provider model reasoning configuration.".to_string())
        })
        .transpose()
}

pub fn deserialize_reasoning_config(raw: Option<String>) -> Option<ModelReasoningConfig> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_config() -> ModelReasoningConfig {
        ModelReasoningConfig {
            default_variant_id: Some("custom".to_string()),
            variants: vec![ReasoningVariant {
                id: "custom".to_string(),
                label: "Custom".to_string(),
                inputs: vec![ReasoningInput {
                    id: "budget".to_string(),
                    input_type: ReasoningInputType::Integer,
                    default_value: Some(1024),
                    min: Some(512),
                    max: Some(8192),
                }],
                request: vec![
                    ReasoningRequestPatch {
                        operation: ReasoningPatchOperation::Set,
                        path: "/thinking/type".to_string(),
                        value: Some(json!("enabled")),
                    },
                    ReasoningRequestPatch {
                        operation: ReasoningPatchOperation::Set,
                        path: "/thinking/budget".to_string(),
                        value: Some(json!({ "$input": "budget" })),
                    },
                ],
            }],
            replay: None,
        }
    }

    #[test]
    fn applies_declarative_reasoning_patches_and_inputs() {
        let config = sample_config();
        let mut body = json!({ "messages": [] });
        apply_reasoning_selection(
            &mut body,
            Some(&config),
            Some(&ProviderReasoningSelection {
                variant_id: "custom".to_string(),
                inputs: BTreeMap::from([("budget".to_string(), json!(2048))]),
            }),
        )
        .unwrap();

        assert_eq!(
            body["thinking"],
            json!({ "type": "enabled", "budget": 2048 })
        );
    }

    #[test]
    fn rejects_out_of_range_reasoning_input() {
        let config = sample_config();
        let error = apply_reasoning_selection(
            &mut json!({}),
            Some(&config),
            Some(&ProviderReasoningSelection {
                variant_id: "custom".to_string(),
                inputs: BTreeMap::from([("budget".to_string(), json!(256))]),
            }),
        )
        .unwrap_err();

        assert!(error.contains("outside its allowed range"));
    }

    #[test]
    fn captures_and_replays_provider_metadata_without_provider_branches() {
        let config = ModelReasoningConfig {
            default_variant_id: None,
            variants: vec![ReasoningVariant {
                id: "default".into(),
                label: "Default".into(),
                inputs: Vec::new(),
                request: Vec::new(),
            }],
            replay: Some(ReasoningReplayRule {
                scope: ReasoningReplayScope::ToolCallTurns,
                capture: vec![ReasoningReplayCapture {
                    response_path: "/delta/reasoning_content".into(),
                    assistant_message_path: "/reasoning_content".into(),
                    operation: ReasoningReplayOperation::Merge,
                    when: None,
                }],
                preserve_exactly: true,
            }),
        };
        let captures = capture_replay_payloads(
            &json!({ "delta": { "reasoning_content": "think" } }),
            Some(&config),
        )
        .unwrap();
        let capture: Value = serde_json::from_str(&captures[0]).unwrap();
        let source = json!({ INTERNAL_REPLAY_FIELD: [capture] });
        let mut target = json!({ "role": "assistant", "content": null });
        apply_message_replay(&source, &mut target).unwrap();

        assert_eq!(target["reasoning_content"], "think");
    }

    #[test]
    fn capture_ignores_top_level_null_fragments_for_every_operation() {
        for operation in [
            ReasoningReplayOperation::Append,
            ReasoningReplayOperation::Prepend,
            ReasoningReplayOperation::Merge,
            ReasoningReplayOperation::Set,
        ] {
            let config = ModelReasoningConfig {
                default_variant_id: None,
                variants: Vec::new(),
                replay: Some(ReasoningReplayRule {
                    scope: ReasoningReplayScope::ActiveToolLoop,
                    capture: vec![ReasoningReplayCapture {
                        response_path: "/delta/reasoning_content".into(),
                        assistant_message_path: "/reasoning_content".into(),
                        operation,
                        when: None,
                    }],
                    preserve_exactly: true,
                }),
            };

            let captures = capture_replay_payloads(
                &json!({ "delta": { "reasoning_content": null } }),
                Some(&config),
            )
            .unwrap();

            assert!(captures.is_empty());
        }
    }

    #[test]
    fn capture_preserves_nested_nulls_in_structured_values() {
        let config = ModelReasoningConfig {
            default_variant_id: None,
            variants: Vec::new(),
            replay: Some(ReasoningReplayRule {
                scope: ReasoningReplayScope::ActiveToolLoop,
                capture: vec![ReasoningReplayCapture {
                    response_path: "/delta/reasoning_details".into(),
                    assistant_message_path: "/reasoning_details".into(),
                    operation: ReasoningReplayOperation::Set,
                    when: None,
                }],
                preserve_exactly: true,
            }),
        };

        let captures = capture_replay_payloads(
            &json!({ "delta": { "reasoning_details": [{ "text": "think", "signature": null }] } }),
            Some(&config),
        )
        .unwrap();
        let capture: Value = serde_json::from_str(&captures[0]).unwrap();

        assert_eq!(
            capture["value"],
            json!([{ "text": "think", "signature": null }])
        );
    }

    #[test]
    fn replay_joins_streamed_reasoning_fragments_for_openai_messages() {
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": null,
                INTERNAL_REPLAY_FIELD: [{
                    "assistantMessagePath": "/reasoning_content",
                    "operation": "append",
                    "value": ["The", " user", " reasoned."]
                }]
            }]
        });

        strip_and_apply_openai_message_replay(&mut body).unwrap();

        assert_eq!(
            body["messages"][0]["reasoning_content"],
            "The user reasoned."
        );
        assert_eq!(body["messages"][0]["content"], "");
        assert!(body["messages"][0].get(INTERNAL_REPLAY_FIELD).is_none());
    }

    #[test]
    fn replay_normalizes_legacy_string_and_null_fragment_arrays() {
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": null,
                INTERNAL_REPLAY_FIELD: [{
                    "assistantMessagePath": "/reasoning_content",
                    "operation": "append",
                    "value": ["The", null, " user", null, " reasoned."]
                }]
            }]
        });

        strip_and_apply_openai_message_replay(&mut body).unwrap();

        assert_eq!(
            body["messages"][0]["reasoning_content"],
            "The user reasoned."
        );
    }

    #[test]
    fn replay_normalizes_legacy_existing_fragment_arrays_before_appending() {
        let source = json!({
            INTERNAL_REPLAY_FIELD: [{
                "assistantMessagePath": "/reasoning_content",
                "operation": "append",
                "value": " continued"
            }]
        });
        let mut target = json!({
            "role": "assistant",
            "content": null,
            "reasoning_content": ["thinking", null]
        });

        apply_message_replay(&source, &mut target).unwrap();

        assert_eq!(target["reasoning_content"], "thinking continued");
    }

    #[test]
    fn ordered_replay_ignores_legacy_top_level_null_entries() {
        let source = json!({
            INTERNAL_REPLAY_FIELD: [
                {
                    "assistantMessagePath": "/reasoning_content",
                    "operation": "append",
                    "value": null
                },
                {
                    "assistantMessagePath": "/reasoning_content",
                    "operation": "prepend",
                    "value": null
                }
            ]
        });
        let mut target = json!({ "reasoning_content": "thinking" });

        apply_message_replay(&source, &mut target).unwrap();

        assert_eq!(target["reasoning_content"], "thinking");
    }

    #[test]
    fn replay_preserves_explicit_set_and_merge_null_entries() {
        let source = json!({
            INTERNAL_REPLAY_FIELD: [
                {
                    "assistantMessagePath": "/set_value",
                    "operation": "set",
                    "value": null
                },
                {
                    "assistantMessagePath": "/merged_value",
                    "operation": "merge",
                    "value": null
                }
            ]
        });
        let mut target = json!({
            "set_value": "before",
            "merged_value": { "nested": true }
        });

        apply_message_replay(&source, &mut target).unwrap();

        assert!(target["set_value"].is_null());
        assert!(target["merged_value"].is_null());
    }

    #[test]
    fn replay_preserves_string_and_null_arrays_for_set_and_merge() {
        let source = json!({
            INTERNAL_REPLAY_FIELD: [
                {
                    "assistantMessagePath": "/set_value",
                    "operation": "set",
                    "value": ["set", null, " text"]
                },
                {
                    "assistantMessagePath": "/merged_value",
                    "operation": "merge",
                    "value": ["merged", null, " text"]
                }
            ]
        });
        let mut target = json!({ "merged_value": null });

        apply_message_replay(&source, &mut target).unwrap();

        assert_eq!(target["set_value"], json!(["set", null, " text"]));
        assert_eq!(target["merged_value"], json!(["merged", null, " text"]));
    }

    #[test]
    fn openai_replay_normalizes_materialized_legacy_reasoning_content() {
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": null,
                "reasoning_content": ["legacy", null, " reasoning"]
            }]
        });

        strip_and_apply_openai_message_replay(&mut body).unwrap();

        assert_eq!(body["messages"][0]["reasoning_content"], "legacy reasoning");
    }

    #[test]
    fn openai_replay_rejects_structured_reasoning_content_arrays() {
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": null,
                "reasoning_content": [{ "type": "reasoning.text", "text": "think" }]
            }]
        });

        let error = strip_and_apply_openai_message_replay(&mut body).unwrap_err();

        assert!(error.contains("reasoning_content must contain text"));
    }

    #[test]
    fn replay_keeps_structured_append_values_as_arrays() {
        let source = json!({
            INTERNAL_REPLAY_FIELD: [{
                "assistantMessagePath": "/reasoning_details",
                "operation": "append",
                "value": [{"id": "a"}, {"id": "b"}]
            }]
        });
        let mut target = json!({ "role": "assistant", "content": null });

        apply_message_replay(&source, &mut target).unwrap();

        assert_eq!(
            target["reasoning_details"],
            json!([{"id": "a"}, {"id": "b"}])
        );
    }

    #[test]
    fn wildcard_capture_replays_each_matching_native_part() {
        let config = ModelReasoningConfig {
            default_variant_id: None,
            variants: vec![ReasoningVariant {
                id: "default".into(),
                label: "Default".into(),
                inputs: Vec::new(),
                request: Vec::new(),
            }],
            replay: Some(ReasoningReplayRule {
                scope: ReasoningReplayScope::ActiveToolLoop,
                capture: vec![ReasoningReplayCapture {
                    response_path: "/parts/*/thoughtSignature".into(),
                    assistant_message_path: "/parts/{$0}/thoughtSignature".into(),
                    operation: ReasoningReplayOperation::Set,
                    when: None,
                }],
                preserve_exactly: true,
            }),
        };
        let captures = capture_replay_payloads(
            &json!({
                "parts": [
                    { "text": "answer" },
                    { "thoughtSignature": "sig-1" },
                    { "thoughtSignature": "sig-2" }
                ]
            }),
            Some(&config),
        )
        .unwrap();

        assert_eq!(captures.len(), 2);
        let entries = captures
            .into_iter()
            .map(|capture| serde_json::from_str::<Value>(&capture).unwrap())
            .collect::<Vec<_>>();
        let source = json!({ INTERNAL_REPLAY_FIELD: entries });
        let mut target = json!({
            "role": "model",
            "parts": [{ "text": "answer" }, {}, {}]
        });
        apply_message_replay(&source, &mut target).unwrap();

        assert_eq!(target["parts"][1]["thoughtSignature"], "sig-1");
        assert_eq!(target["parts"][2]["thoughtSignature"], "sig-2");
    }

    #[test]
    fn replay_capture_condition_filters_unrelated_native_blocks() {
        let config = ModelReasoningConfig {
            default_variant_id: None,
            variants: Vec::new(),
            replay: Some(ReasoningReplayRule {
                scope: ReasoningReplayScope::ActiveToolLoop,
                capture: vec![ReasoningReplayCapture {
                    response_path: "/content_block".into(),
                    assistant_message_path: "/content/{/index}".into(),
                    operation: ReasoningReplayOperation::Merge,
                    when: Some(ReasoningReplayCondition {
                        response_path: "/content_block/type".into(),
                        equals: json!("thinking"),
                    }),
                }],
                preserve_exactly: true,
            }),
        };

        let text_captures = capture_replay_payloads(
            &json!({ "index": 0, "content_block": { "type": "text", "text": "Hi" } }),
            Some(&config),
        )
        .unwrap();
        let thinking_captures = capture_replay_payloads(
            &json!({ "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            Some(&config),
        )
        .unwrap();

        assert!(text_captures.is_empty());
        assert_eq!(thinking_captures.len(), 1);
    }
}
