export const CSS = `
.dcr{display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dcr-workbench{padding-top:var(--dsh-frame-top-clearance,0px)}
.dcr-top{display:flex;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dcr-candidate-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-2)}
.dcr-top h1{margin:0;font-size:16px;font-weight:650}
.dcr-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcr-grow{flex:1;min-width:0}
.dcr-body{flex:1;min-height:0;overflow:auto;padding:18px;scrollbar-gutter:stable}
.dcr-central-nav{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dcr-central-nav button[aria-selected="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dcr-central-frame{display:block;flex:1;width:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base)}
.dcr-central-path{overflow-wrap:anywhere;white-space:normal}
.dcr-wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.dcr-connection{max-width:820px;gap:18px;container-type:inline-size}
.dcr-connection-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
.dcr-connection-head h1{margin:0;font-size:22px;line-height:1.35;font-weight:650}
.dcr-connection .dcr-connection-card{padding:20px;display:grid;gap:16px;min-width:0}
.dcr-connection-card h2,.dcr-connection-card p{margin:0}
.dcr-connection-card h2{font-size:16px;line-height:1.4}
.dcr-connection-section{display:grid;gap:12px;min-width:0}
.dcr-connection-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dcr-connection-mode{display:grid;align-content:start;gap:5px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-width:0;background:var(--dsw-alias-bg-base);color:inherit;text-align:left;font:inherit;cursor:pointer}
.dcr-connection-mode:not(:disabled):hover,.dcr-connection-mode[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary)}
.dcr-connection-mode[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-base))}
.dcr-connection-mode:disabled{opacity:.6;cursor:not-allowed}
.dcr-connection-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dcr-connection-fields .dcr-field{margin:0;min-width:0}
.dcr-connection-fields .dcr-field:first-child{grid-column:1/-1}
.dcr-connection-fields .dcr-input{padding:8px 10px}
.dcr-connection-fields [aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
.dcr-connection-meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 16px;margin:0}
.dcr-connection-meta dt{color:var(--dsw-alias-label-secondary)}
.dcr-connection-meta dd{margin:0;overflow-wrap:anywhere}
.dcr-connection-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dcr-connection-actions .dcr-btn{min-height:34px;white-space:normal}
.dcr-connection-card progress{width:100%;accent-color:var(--dsw-alias-brand-primary)}
.dcr-saved-connection{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dcr-saved-connection small{display:block;overflow-wrap:anywhere}
.dcr-connection-checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;list-style:none;padding:0;margin:0}
.dcr-connection-checks li{display:flex;gap:7px;align-items:first baseline;padding:8px 10px;line-height:1.45;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px}
.dcr-connection-checks .passed span{color:var(--dsw-alias-state-success-primary)}
.dcr-connection-checks .failed span{color:var(--dsw-alias-state-error-primary)}
.dcr-connection-feedback{display:grid;gap:8px}
.dcr-connection-feedback .dcr-banner{padding:12px 14px;color:var(--dsw-alias-label-primary);font-size:13px}
.dcr-connection-feedback p{margin:4px 0 0}
.dcr-connection-diagnostics{border-top:1px solid var(--dsw-alias-border-l1);padding:12px 0;min-width:0}
.dcr-connection-diagnostics summary{width:fit-content;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dcr-connection-diagnostics pre{overflow-wrap:anywhere}
.dcr-connection :is(button,input,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@container (max-width:550px){
    .dcr-connection .dcr-connection-card{padding:14px}
    .dcr-connection-modes,.dcr-connection-fields,.dcr-connection-checks{grid-template-columns:minmax(0,1fr)}
    .dcr-connection-meta{gap:8px 12px}
}
.dcr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 11px;font:inherit;cursor:pointer;line-height:18px;white-space:nowrap}
.dcr-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.dcr-btn[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dcr-btn:disabled{opacity:.45;cursor:not-allowed}
.dcr-btn.p{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dcr-btn.d{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-btn.g{border-color:transparent;background:transparent}
.dcr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.dcr-card h3{margin:0 0 8px;font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-secondary);letter-spacing:.2px}
.dcr-pre{white-space:pre-wrap;word-break:break-word;line-height:1.55;margin:0;font-family:inherit}
.dcr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dcr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dcr-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dcr-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcr-chip.pending,.dcr-chip.changes_requested,.dcr-chip.warn,.dcr-chip.awaiting_verification,.dcr-chip.human_takeover{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcr-chip.approved,.dcr-chip.resolved{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcr-chip.rejected,.dcr-chip.repair_failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-counts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dcr-count-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 9px;font-size:11.5px;cursor:pointer}
.dcr-count-btn.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dcr-list{display:flex;flex-direction:column;gap:10px}
.dcr-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px;cursor:pointer}
.dcr-item:hover{border-color:var(--dsw-alias-brand-primary)}
.dcr-item h2{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.dcr-meta{display:flex;gap:9px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:6px}
.dcr-input,.dcr-select,.dcr-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 8px;font:inherit;min-width:0}
.dcr-textarea{width:100%;box-sizing:border-box;min-height:70px;resize:vertical;line-height:1.5}
.dcr-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.dcr-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcr-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dcr-checks{display:flex;gap:14px;flex-wrap:wrap;font-size:12px}
.dcr-check{display:flex;gap:6px;align-items:flex-start;font-size:12px}
.dcr-banner{border:1px solid;border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.5}
.dcr-banner.info{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.dcr-banner.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-state-warn-primary)}
.dcr-banner.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary)}
.dcr-judge{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent);border-radius:10px;padding:13px 15px}
.dcr-judge h3{color:var(--dsw-alias-state-warn-primary)}
.dcr-judge-item{display:flex;gap:10px;padding:7px 0;border-top:1px dashed color-mix(in srgb,var(--dsw-alias-state-warn-primary) 28%,transparent)}
.dcr-judge-item:first-of-type{border-top:0}
.dcr-judge-label{font-weight:600;min-width:140px}
.dcr-diff{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dcr-diff-bar{display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dcr-file-tree{display:flex;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dcr-diff-body{max-height:620px;overflow:auto}
.dcr-file{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l1);padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;user-select:none}
.dcr-line{display:grid;grid-template-columns:42px 42px 16px 1fr 18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;min-height:20px}
.dcr-line:hover{background:var(--dsw-alias-bg-layer-2)}
.dcr-num{text-align:right;padding-right:6px;color:var(--dsw-alias-state-idle-primary);user-select:none}
.dcr-sign{text-align:center;color:var(--dsw-alias-label-secondary)}
.dcr-code{white-space:pre-wrap;word-break:break-all;padding-right:8px}
.dcr-line.add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dcr-line.del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.dcr-line.add .dcr-sign{color:var(--dsw-alias-state-success-primary)}
.dcr-line.del .dcr-sign{color:var(--dsw-alias-state-error-primary)}
.dcr-line.meta{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dcr-plus{opacity:0;color:var(--dsw-alias-brand-primary);cursor:pointer;font-weight:700;text-align:center}
.dcr-line:hover .dcr-plus{opacity:1}
.dcr-srow:hover .dcr-plus{opacity:1}
.dcr-srows{display:flex;flex-direction:column}
.dcr-srow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:stretch}
.dcr-shalf{display:grid;grid-template-columns:44px 14px minmax(0,1fr) 16px;align-items:stretch;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;min-height:20px}
.dcr-shalf + .dcr-shalf{border-left:1px solid var(--dsw-alias-border-l1)}
.dcr-shalf.add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.dcr-shalf.del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.dcr-shalf.empty{background:var(--dsw-alias-bg-base)}
.dcr-shalf.add .dcr-sign{color:var(--dsw-alias-state-success-primary)}
.dcr-shalf.del .dcr-sign{color:var(--dsw-alias-state-error-primary)}
.dcr-shalf .dcr-code{padding-right:6px}
.dcr-srow:hover .dcr-shalf{background:var(--dsw-alias-bg-layer-2)}
.dcr-smeta{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:20px;white-space:pre-wrap;word-break:break-all}
.dcr-thread.split{margin-left:10px;margin-right:10px}
.dcr-thread{margin:2px 10px 6px 106px;padding:7px 10px;border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:0 6px 6px 0}
.dcr-thread-head{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.dcr-st-unresolved{color:var(--dsw-alias-state-error-primary)}.dcr-st-partial{color:var(--dsw-alias-state-warn-primary)}.dcr-st-resolved{color:var(--dsw-alias-state-success-primary)}
.dcr-approve{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,var(--dsw-alias-bg-layer-1))}
.dcr-approve-acks{display:flex;flex-direction:column;gap:4px;margin:8px 0 4px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-base)}
.dcr-approve-acks .dcr-small{margin-bottom:2px}
.dcr-approve-steps{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.dcr-commit{margin-top:10px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-base)}
.dcr-seg{display:inline-flex;gap:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}
.dcr-seg .dcr-btn{border:0;border-radius:0;border-right:1px solid var(--dsw-alias-border-l2)}
.dcr-seg .dcr-btn:last-child{border-right:0}
.dcr-commit-preview{margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px 10px}
.dcr-step{display:flex;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-base)}
.dcr-step-no{flex:none;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:11px;display:flex;align-items:center;justify-content:center;font-weight:700}
.dcr-step-title{font-weight:600;font-size:12px}
.dcr-step-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.45;margin-top:2px}
.dcr-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}
.dcr-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-base)}
.dcr-kpi-label{font-size:10.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.4px;text-transform:uppercase}
.dcr-kpi-value{font-size:13px;font-weight:600;margin-top:2px}
.dcr-kpi-value.warn{color:var(--dsw-alias-state-warn-primary)}
.dcr-kpi-value.ok{color:var(--dsw-alias-state-success-primary)}
.dcr-rt{max-width:78ch;line-height:1.68;font-size:13px}
.dcr-rt p{margin:0 0 9px}
.dcr-rt p:last-child{margin-bottom:0}
.dcr-rt ul,.dcr-rt ol{margin:4px 0 10px;padding-left:20px}
.dcr-rt li{margin:3px 0;padding-left:2px}
.dcr-rt strong{font-weight:650}
.dcr-rt a{color:var(--dsw-alias-brand-primary);text-decoration:none}
.dcr-rt a:hover{text-decoration:underline}
.dcr-rt-h{font-weight:650;margin:12px 0 6px;font-size:13px}
.dcr-rt-h:first-child{margin-top:0}
.dcr-rt-h1{font-size:14px}
.dcr-rt-h2{font-size:13.5px}
.dcr-rt-h3,.dcr-rt-h4{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dcr-rt code,.dcr-inline-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 3px}
.dcr-codeblock{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:9px 10px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;margin:6px 0 10px}
.dcr-gate-item{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;margin-bottom:5px;background:var(--dsw-alias-bg-base);overflow-wrap:anywhere}
.dcr-job{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.dcr-job.failed{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dcr-joblog{margin-top:8px}
.dcr-joblog summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none}
.dcr-joblog[open] summary{margin-bottom:6px}
.dcr-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);user-select:none;margin-bottom:6px}
.dcr-details[open] summary{margin-bottom:8px}
.dcr-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:40px 20px}
.dcr-log{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;max-height:330px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap}
.dcr-small{font-size:11.5px}.dcr-muted{color:var(--dsw-alias-label-secondary)}
.dcr-hist{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 11px;margin-bottom:7px}
.dcr-raw{white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.5}
.dcr-sep{height:1px;background:var(--dsw-alias-border-l1);margin:8px 0}
@media(max-width:760px){.dcr-grid{grid-template-columns:1fr}.dcr-line{grid-template-columns:32px 32px 14px 1fr 18px}.dcr-shalf{grid-template-columns:30px 12px minmax(0,1fr) 16px}.dcr-thread{margin-left:80px}.dcr-thread.split{margin-left:10px}}
`;
