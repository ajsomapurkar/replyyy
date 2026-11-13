import os; os.makedirs("e2e/screenshots", exist_ok=True)
import json, urllib.request
from playwright.sync_api import sync_playwright
acc={a['name']:a for a in json.load(urllib.request.urlopen('http://localhost:4000/api/v1/auth/demo-accounts'))['accounts']}
def sess(n):
    r=urllib.request.Request('http://localhost:4000/api/v1/auth/demo-session',data=json.dumps({'userId':acc[n]['id']}).encode(),headers={'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r))
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    def page(url, n=None, w=400, h=860):
        ctx=b.new_context(viewport={'width':w,'height':h}, device_scale_factor=2)
        pg=ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: m.type=='error' and errs.append(m.text))
        pg.goto(url)
        if n: pg.evaluate("s=>localStorage.setItem('relay.session', JSON.stringify(s))", sess(n)); pg.reload()
        return pg
    lg=page('http://localhost:5174'); lg.wait_for_timeout(1200); lg.screenshot(path='e2e/screenshots/r0-login.png')
    r=page('http://localhost:5174','Priya Nair'); r.wait_for_timeout(2500); r.screenshot(path='e2e/screenshots/r1-home.png')
    r.get_by_text('Where are you going?').click(); r.wait_for_timeout(500); r.screenshot(path='e2e/screenshots/r2-search.png')
    r.get_by_role('button', name='Orbit Towers').first.click(); r.wait_for_timeout(2500); r.screenshot(path='e2e/screenshots/r3-options.png')
    r.get_by_role('button', name='Book').last.click(); r.wait_for_timeout(2500); r.screenshot(path='e2e/screenshots/r4-finding.png')
    d=page('http://localhost:5175','Arjun Rao'); d.wait_for_timeout(2500); d.screenshot(path='e2e/screenshots/d1-offer.png')
    d.get_by_role('button', name='Accept').click(); d.wait_for_timeout(2500); d.screenshot(path='e2e/screenshots/d2-trip.png')
    r.wait_for_timeout(2000); r.screenshot(path='e2e/screenshots/r5-enroute.png')
    w=page('http://localhost:5174','Rahul Mehta', 1366, 820); w.wait_for_timeout(2500); w.get_by_text('Where are you going?').click(); w.get_by_role('button', name='Central Market').first.click(); w.wait_for_timeout(2500); w.screenshot(path='e2e/screenshots/r6-desktop.png')
    o=page('http://localhost:5173','Kavya Menon', 1440, 900); o.goto('http://localhost:5173/ops'); o.wait_for_timeout(3500); o.locator('.row-item').first.click(); o.wait_for_timeout(2000); o.screenshot(path='e2e/screenshots/o1.png')
    b.close()
print('ERR', errs[:6])
