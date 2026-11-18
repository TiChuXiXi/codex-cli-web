import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// This source overlay targets openai/codex rust-v0.169.1.
// All anchors are checked before writing any files.
const source = process.argv[2]
if (!source) throw new Error('Usage: node scripts/prepare-router-codex.mjs /path/to/codex-rust-v0.169.1')

const files = [
  ['codex-rs/core/src/lib.rs', 'mod apply_patch;', `pub const WEB_ROUTER_NAMESPACE: &str = "codex_web_router";
pub const WEB_ROUTER_TOOLS: &[&str] = &[
    "list_projects",
    "list_sessions",
    "get_session",
    "create_session",
    "dispatch_task",
    "get_task_status",
    "interrupt_task",
];

pub(crate) fn web_router_tool_policy() -> codex_extension_api::ToolPolicy {
    use codex_extension_api::{ToolName, ToolPolicy};
    ToolPolicy {
        allowed_tools: Some(
            WEB_ROUTER_TOOLS.iter()
                .map(|name| ToolName::namespaced(WEB_ROUTER_NAMESPACE, *name))
                .collect(),
        ),
        require_managed_sandbox: true,
        require_unified_exec: true,
        expose_additional_permissions: false,
    }
}

mod apply_patch;`],
  ['codex-rs/core/src/session/session.rs', `        let tool_policy = thread_extension_init
            .get::<codex_extension_api::ToolPolicy>()`, `        // A dedicated Web Router binary applies its ceiling to new and resumed sessions.
        thread_extension_init.insert(crate::web_router_tool_policy());
        let tool_policy = thread_extension_init
            .get::<codex_extension_api::ToolPolicy>()`],
  ['codex-rs/app-server-protocol/src/protocol/common.rs',
    '/// Authentication mode for OpenAI-backed providers.',
    `#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebRouterCapabilitiesResponse {
    pub policy_version: u32,
    pub tools: Vec<String>,
}

/// Authentication mode for OpenAI-backed providers.`],
  ['codex-rs/app-server-protocol/src/protocol/common.rs',
    '            InterruptConversation(v1::InterruptConversationResponse),',
    `            WebRouterCapabilities(WebRouterCapabilitiesResponse),
            InterruptConversation(v1::InterruptConversationResponse),`],
  ['codex-rs/app-server-protocol/src/protocol/common.rs',
    '                    Self::InterruptConversation(_) => None,',
    '                    Self::WebRouterCapabilities(_) | Self::InterruptConversation(_) => None,'],
  ['codex-rs/app-server/src/message_processor.rs', `        let request_span =
            crate::app_server_tracing::request_span(&request, transport, connection_id, &session);`, `        if request_method == "router/capabilities" {
            if !session.initialized() {
                self.outgoing.send_error(request_id, invalid_request("Not initialized")).await;
                return;
            }
            let tools: Vec<String> = codex_core::WEB_ROUTER_TOOLS
                .iter()
                .map(|name| format!("{}/{name}", codex_core::WEB_ROUTER_NAMESPACE))
                .collect();
            let response = codex_app_server_protocol::WebRouterCapabilitiesResponse {
                policy_version: 1,
                tools,
            };
            self.outgoing.send_response_as(
                request_id,
                codex_app_server_protocol::ClientResponsePayload::WebRouterCapabilities(response),
            ).await;
            return;
        }
        if !matches!(
            request_method,
            "initialize" | "model/list" | "thread/start" | "thread/resume" |
            "thread/read" | "thread/turns/list" | "turn/start"
        ) {
            self.outgoing.send_error(request_id, invalid_request("Unsupported Router method")).await;
            return;
        }
        let request_span =
            crate::app_server_tracing::request_span(&request, transport, connection_id, &session);`],
]

const manifest = await readFile(resolve(source, 'codex-rs/Cargo.toml'), 'utf8')
if (!/^version\s*=\s*"0\.169\.1"$/m.test(manifest)) throw new Error('Expected upstream Codex rust-v0.169.1 source')

const pending = new Map()
for (const [file, anchor, replacement] of files) {
  const path = resolve(source, file)
  const original = pending.get(path) ?? await readFile(path, 'utf8')
  if (original.includes(replacement)) continue
  if (original.split(anchor).length !== 2) throw new Error('Unexpected Router policy anchor in ' + file)
  pending.set(path, original.replace(anchor, replacement))
}
for (const [path, content] of pending) await writeFile(path, content)
console.log('Prepared dedicated Web Router App Server source')
