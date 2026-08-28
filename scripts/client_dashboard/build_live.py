#!/usr/bin/env python3
"""build_live.py -- emit the LIVE (hosted, always-current) dashboard page.

`build.py` freezes a client's data into a standalone file. That file is only as
fresh as the last time it ran on Jack's PC. This script emits ONE page instead:

    public/dashboards/live.html

which fetches /api/dashboard/<slug> at load time, so a client link stays current
forever with no rebuild, and adding a client means adding an entry to
app/api/dashboard/clients.ts -- nothing else.

    https://<wing-os>/dashboards/live.html?c=heros-junk
    https://<wing-os>/dashboards/live.html?c=jackson-roofing

Run after any edit to template.html:  python build_live.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "template.html")
OUT = os.path.join(HERE, "..", "..", "public", "dashboards", "live.html")

BOOT = r"""
// ── LIVE MODE ────────────────────────────────────────────────────────────────
// Data is fetched from /api/dashboard/<slug> at page load, so this one hosted
// file stays current for every client with no rebuild on Jack's PC.
(function(){
  var slug = new URLSearchParams(location.search).get('c') || 'heros-junk';
  fetch('/api/dashboard/' + encodeURIComponent(slug), {cache:'no-store'})
    .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d){
      if (d.theme) {
        var root = document.documentElement;
        // Config keys are snake_case; CSS custom properties are kebab-case.
        Object.keys(d.theme).forEach(function(k){
          root.style.setProperty('--' + k.replace(/_/g, '-'), d.theme[k]);
        });
      }
      if (d.brand && d.brand.name) document.title = d.brand.name + ' Dashboard';
      window.DATA = d;
      bootDashboard();
    })
    .catch(function(e){
      // Never render a confident-looking empty dashboard on a failed fetch: a
      // client reads zeros as "you did nothing for me this month".
      document.body.innerHTML = '<div style="max-width:640px;margin:80px auto;padding:0 24px;'+
        'font-family:ui-sans-serif,system-ui,sans-serif;color:#1c1a17">'+
        '<h1 style="font-size:1.3rem;margin-bottom:10px">Dashboard temporarily unavailable</h1>'+
        '<p style="color:#666;line-height:1.6">We could not load this dashboard just now ('+
        String(e.message)+'). Nothing is wrong with your website. Please refresh in a moment.</p></div>';
    });
})();
"""

# Build-time placeholder defaults. In live mode these only ever act as the
# var() fallback -- the real per-client values arrive in the API payload.
DEFAULTS = {
    "__ACCENT__": "#e8a33d", "__ACCENT2__": "#f0c274",
    "__ACCENT_BG__": "rgba(232,163,61,.11)", "__ACCENT_GLOW__": "rgba(232,163,61,.18)",
    "__ACCENT_L__": "#b8760f", "__ACCENT2_L__": "#e0a13c",
    "__ACCENT_BG_L__": "rgba(184,118,15,.09)", "__ACCENT_GLOW_L__": "rgba(184,118,15,.13)",
    "__MARK_BG__": "#1c1a17", "__MARK_FG__": "#ffffff",
    "__TITLE__": "Client Dashboard",
}


def main():
    tpl = open(TEMPLATE, encoding="utf-8").read()

    # The page's script normally runs immediately against a literal DATA. Wrap it
    # in bootDashboard() so the fetch can call it once the payload lands. The name
    # is deliberately distinct from the inner render() used by the content table.
    tpl = tpl.replace(
        "const DATA = __DATA__;\n\n(function(){\n  'use strict';",
        "var DATA = null;\nfunction bootDashboard(){\n  'use strict';\n  DATA = window.DATA;")
    tpl = tpl.replace("})();\n</script>", "}\n" + BOOT + "\n</script>")

    for ph, dflt in DEFAULTS.items():
        tpl = tpl.replace(ph, dflt)

    # Fail loudly rather than shipping a half-rewritten page.
    assert "bootDashboard()" in tpl, "boot wrapper not injected"
    assert "__DATA__" not in tpl and "__ACCENT__" not in tpl, "placeholders left unreplaced"

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(tpl)
    print("wrote %s (%d bytes)" % (os.path.normpath(OUT), len(tpl)))
    print("  https://<wing-os>/dashboards/live.html?c=<slug>")


if __name__ == "__main__":
    main()
