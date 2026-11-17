/** Scoped version manager; loaded after the shared dialog styles. */
export const VERSIONS_CSS = `
.dsh-codex-root .dsh-codex-dialog.dsh-codex-versions{width:min(640px,calc(100vw - 40px));padding:0;gap:0;overflow:hidden;line-height:1.6;color:var(--codex-text);outline:none}
.dsh-codex-versions .versions-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:22px 24px 18px;border-bottom:1px solid var(--codex-border);flex:none}
.dsh-codex-versions h2,.dsh-codex-versions h3,.dsh-codex-versions p,.dsh-codex-versions dl,.dsh-codex-versions dd{margin:0}
.dsh-codex-versions h2{font-size:18px;font-weight:650;line-height:1.5}
.dsh-codex-versions .versions-header p{font-size:13px;color:var(--codex-muted);margin-top:3px}
.dsh-codex-versions .versions-header .dsh-codex-icon-button{width:32px;height:32px;margin-right:-6px}
.dsh-codex-versions .versions-body{padding:22px 24px;overflow:auto;min-height:0;overscroll-behavior:contain}
.dsh-codex-versions .versions-body>section+section,.dsh-codex-versions .versions-advanced{margin-top:24px}
.dsh-codex-versions h3{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.dsh-codex-versions .versions-update{padding:18px;background:var(--codex-panel);border-radius:10px}
.dsh-codex-versions .versions-update-heading{display:flex;align-items:center;gap:12px}
.dsh-codex-versions .versions-update h3{font-size:17px;line-height:1.5}
.dsh-codex-versions .versions-update p{font-size:13px;color:var(--codex-muted);margin-top:3px}
.dsh-codex-versions .versions-state-icon{width:40px;height:40px;display:grid;place-items:center;flex:none;color:var(--codex-muted)}
.dsh-codex-versions .is-current .versions-state-icon{color:var(--codex-success)}
.dsh-codex-versions .is-available .versions-state-icon{color:var(--codex-accent)}
.dsh-codex-versions .versions-update-actions{display:flex;align-items:center;gap:8px;margin-top:16px;padding-left:52px;flex-wrap:wrap}
.dsh-codex-versions .versions-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.dsh-codex-versions .versions-facts{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding-bottom:18px}
.dsh-codex-versions .versions-facts dt{font-size:12px;color:var(--codex-muted);margin-bottom:4px}
.dsh-codex-versions .versions-facts dd{font-size:14px;font-weight:550;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.dsh-codex-versions .versions-daemon{padding-top:16px;border-top:1px solid var(--codex-border);display:flex;flex-direction:column;gap:12px}
.dsh-codex-versions .versions-daemon>div:first-child{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13px}
.dsh-codex-versions .versions-daemon strong{font-weight:550;font-variant-numeric:tabular-nums}
.dsh-codex-versions .versions-daemon small{color:var(--codex-warning);font-size:12px}
.dsh-codex-versions .versions-daemon-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-codex-versions .versions-health{padding-top:20px;border-top:1px solid var(--codex-border)}
.dsh-codex-versions .versions-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:5px;font-size:12px;color:var(--codex-muted);background:var(--codex-panel)}
.dsh-codex-versions .versions-badge.is-ok{color:var(--codex-success);background:var(--codex-success-bg)}
.dsh-codex-versions .versions-badge.is-warn{color:var(--codex-warning);background:var(--codex-warning-bg)}
.dsh-codex-versions .versions-badge.is-error{color:var(--codex-danger);background:var(--codex-danger-bg)}
.dsh-codex-versions .versions-check{display:flex;gap:10px;padding:10px 0;align-items:flex-start}
.dsh-codex-versions .versions-check+.versions-check{border-top:1px solid var(--codex-border)}
.dsh-codex-versions .versions-check>svg{margin-top:3px}
.dsh-codex-versions .versions-check>div{min-width:0}
.dsh-codex-versions .versions-check code{font-family:var(--dsh-font-family-code);font-size:12px;color:var(--codex-muted);overflow-wrap:anywhere}
.dsh-codex-versions .versions-check p{font-size:13px;overflow-wrap:anywhere;margin-top:3px}
.dsh-codex-versions .versions-check .versions-remediation{color:var(--codex-muted);margin-top:5px}
.dsh-codex-versions .versions-warning-text{color:var(--codex-warning)}
.dsh-codex-versions .versions-error-text{color:var(--codex-danger)}
.dsh-codex-versions .versions-muted{font-size:12px;color:var(--codex-muted)}
.dsh-codex-versions .versions-advanced{border-top:1px solid var(--codex-border);padding-top:16px}
.dsh-codex-versions .versions-advanced>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;font-size:13px;min-height:32px;border-radius:4px}
.dsh-codex-versions .versions-advanced>summary::-webkit-details-marker{display:none}
.dsh-codex-versions .versions-advanced>summary>svg:last-child{margin-left:auto;transition:transform 160ms ease}
.dsh-codex-versions .versions-advanced[open]>summary>svg:last-child{transform:rotate(180deg)}
.dsh-codex-versions .versions-advanced summary:hover{color:var(--codex-accent)}
.dsh-codex-versions summary:focus-visible{outline:2px solid var(--codex-accent);outline-offset:3px}
.dsh-codex-versions .versions-rollback p{font-size:13px;color:var(--codex-muted);margin:8px 0 14px}
.dsh-codex-versions .versions-rollback label{display:block;font-size:12px;margin-bottom:6px}
.dsh-codex-versions .versions-rollback form{display:flex;gap:8px}
.dsh-codex-versions .versions-rollback .dsh-codex-search{flex:1;width:0;margin:0}
.dsh-codex-versions .versions-task{padding:14px 16px;border:1px solid var(--codex-border);border-radius:8px}
.dsh-codex-versions .versions-task .versions-section-heading{margin-bottom:0;font-size:12px}
.dsh-codex-versions .versions-task.is-done .versions-section-heading{color:var(--codex-success)}
.dsh-codex-versions .versions-task.is-error .versions-section-heading{color:var(--codex-danger)}
.dsh-codex-versions .versions-task-hint{font-size:13px;margin-top:8px;color:var(--codex-muted)}
.dsh-codex-versions .versions-log{margin-top:10px}
.dsh-codex-versions .versions-log summary{font-size:12px;cursor:pointer;color:var(--codex-muted)}
.dsh-codex-versions .versions-log pre{font-family:var(--dsh-font-family-code);font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;background:var(--codex-panel);padding:12px;margin:8px 0 0;border-radius:5px}
.dsh-codex-versions .versions-error{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:var(--codex-danger-bg);color:var(--codex-danger);font-size:13px;border-radius:8px;margin-bottom:18px;overflow-wrap:anywhere}
.dsh-codex-versions .versions-error>svg{margin-top:2px}
.dsh-codex-versions .versions-error>div{min-width:0}
.dsh-codex-versions .versions-force{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px}
.dsh-codex-versions .versions-confirm{margin-top:14px;padding:14px;background:var(--codex-warning-bg);color:var(--codex-warning);font-size:13px;border-radius:8px}
.dsh-codex-versions .versions-confirm>div{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dsh-codex-versions .versions-loading{display:flex;align-items:center;justify-content:center;gap:10px;min-height:180px;color:var(--codex-muted);font-size:14px}
.dsh-codex-versions .versions-loading p{font-size:12px;margin-top:5px;max-width:32ch}
.dsh-codex-versions .versions-spinner{animation:dsh-codex-versions-spin 1s linear infinite;transform-origin:center;flex-shrink:0}
@keyframes dsh-codex-versions-spin{to{transform:rotate(360deg)}}
.dsh-codex-versions .versions-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 24px;border-top:1px solid var(--codex-border);flex:none}
@media(max-width:560px){
 .dsh-codex-root .dsh-codex-dialog.dsh-codex-versions{width:calc(100vw - 24px);max-height:calc(100dvh - 24px)}
 .dsh-codex-versions .versions-header{padding:18px}
 .dsh-codex-versions .versions-body{padding:18px}
 .dsh-codex-versions .versions-footer{padding:12px 18px}
 .dsh-codex-versions .versions-update{padding:14px}
 .dsh-codex-versions .versions-update-actions{padding-left:0}
 .dsh-codex-versions .versions-update h3{font-size:16px}
 .dsh-codex-versions .versions-facts{gap:8px}
 .dsh-codex-versions .versions-daemon-actions{gap:6px}
}
@media(prefers-reduced-motion:reduce){.dsh-codex-versions .versions-advanced>summary>svg:last-child{transition:none}.dsh-codex-versions .versions-spinner{animation:none}}
`
