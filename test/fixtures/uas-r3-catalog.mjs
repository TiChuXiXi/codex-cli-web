// Static model input shared by offline and authorized live R3 probes.
export function r3Catalog(model, clockControl = false) {
  return { models: [{ slug: model, display_name: model, model_messages: { instructions_template: 'Answer the synthetic protocol check briefly.' },
    shell_type: 'disabled', visibility: 'list', priority: 1, supported_in_api: true, support_verbosity: false,
    supported_reasoning_levels: [], experimental_supported_tools: clockControl ? ['clock'] : [], truncation_policy: { mode: 'tokens', limit: 1000 },
    supports_parallel_tool_calls: false, include_apps_usage_instructions: false, context_window: 100000 }] }
}
