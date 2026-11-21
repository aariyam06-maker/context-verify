"""Real Playwright UI tests; no API upload substitutes. Preserves screenshots and downloads."""
import json,time,argparse
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2];args=argparse.ArgumentParser();args.add_argument("--output",default="demo");args.add_argument("--case",default="all");args.add_argument("--base-url",default="http://localhost:3000");args.add_argument("--record",action="store_true");args=args.parse_args();OUT=ROOT/"test-results"/args.output;OUT.mkdir(parents=True,exist_ok=True)
samples=ROOT/"sample_videos"
ai=samples/"veo3.1.mp4";real=samples/"real_baseline.mp4";cut=samples/"real_cut.mp4"
records=[];errors=[]
def save(): (OUT/"results.json").write_text(json.dumps({"cases":records,"page_errors":errors},indent=2),encoding="utf-8")
with sync_playwright() as p:
    installed=sorted((Path.home()/"AppData/Local/ms-playwright").glob("chromium_headless_shell-*/**/chrome-headless-shell.exe"));exe=installed[-1] if installed else None
    browser=p.chromium.launch(headless=True,executable_path=str(exe) if exe else None);context=browser.new_context(viewport={"width":1440,"height":1100},accept_downloads=True,record_video_dir=OUT/"recordings" if args.record else None,record_video_size={"width":1440,"height":1100} if args.record else None)
    page=context.new_page();page.set_default_timeout(60000);page.on("pageerror",lambda e:errors.append(str(e)))
    page.goto(args.base_url + "/auth",wait_until="domcontentloaded")
    page.get_by_role("button").filter(has_text="demo@contexttrace.app").wait_for()
    page.screenshot(path=str(OUT/"launch.png"),full_page=True)
    page.get_by_role("button").filter(has_text="demo@contexttrace.app").click()
    page.wait_for_url("**/dashboard",timeout=20000)
    for name,mode,files,expected in (("real","detect",[real],"Likely camera-recorded"),("ai","detect",[ai],"Likely AI-generated"),("cut","tamper",[real,cut],"Located tampering evidence"),("unrelated","tamper",[real,ai],"Videos are unrelated")):
        if args.case not in ("all",name):continue
        row={"id":name,"input":[str(f.relative_to(ROOT)) for f in files],"expected":expected,"browser":browser.version};start=time.perf_counter()
        try:
            page.goto(args.base_url+"/"+mode,wait_until="domcontentloaded")
            for i,f in enumerate(files):page.locator('input[type=file]').nth(i).set_input_files(str(f))
            page.screenshot(path=str(OUT/(name+'-input.png')),full_page=True)
            page.get_by_role("button",name="Analyse video" if mode=="detect" else "Compare videos").click()
            page.wait_for_url("**/result/**",timeout=20000)
            report_button=page.get_by_role("button",name="PDF report")
            progress=page.get_by_text("Typical runtime on a laptop CPU",exact=False)
            progress.or_(report_button).first.wait_for(state="visible",timeout=180000)
            row["observed_progress"]=progress.is_visible()
            if row["observed_progress"]:
                row["loading_text"]=page.locator('body').inner_text()
                page.screenshot(path=str(OUT/(name+'-progress.png')),full_page=True)
            report_button.wait_for(state="visible",timeout=180000)
            text=page.locator('body').inner_text();row["rendered_text"]=text;row["url"]=page.url;row["pass"]=expected.lower() in text.lower();row["timeline_svg_count"]=page.locator('.recharts-wrapper svg').count()
            page.screenshot(path=str(OUT/(name+'-result.png')),full_page=True)
            for label,ext in (("PDF report","pdf"),("JSON","json")):
                with page.expect_download(timeout=20000) as download:
                    page.get_by_role("button",name=label,exact=True).click()
                dest=OUT/(name+'-report.'+ext);download.value.save_as(str(dest));row[ext+"_download_bytes"]=dest.stat().st_size
                if ext=="pdf":assert dest.read_bytes().startswith(b"%PDF")
            if mode=='tamper' and name=='cut':
                result=json.loads((OUT/(name+'-report.json')).read_text())['result'];event=next(e for e in result['events'] if e['type']=='removed_segment');row['removed_interval']=[event['start'],event['end']];row['pass'] &= abs(event['start']-2)<.11 and abs(event['end']-3)<.11;row['shaded_interval_count']=page.locator('.recharts-reference-area').count();row['pass'] &= row['shaded_interval_count']>0
            if mode=='tamper' and name=='cut':
                buttons=page.get_by_role('button').filter(has_text='Removed footage')
                if buttons.count():buttons.first.click();page.wait_for_timeout(200);row['video_times_after_event_click']=page.locator('video').evaluate_all('(els)=>els.map(e=>e.currentTime)')
        except Exception as e:
            row.update({"pass":False,"error":str(e)});page.screenshot(path=str(OUT/(name+'-error.png')),full_page=True)
        row["seconds"]=time.perf_counter()-start;records.append(row);save();print(json.dumps({k:v for k,v in row.items() if k not in ('rendered_text','loading_text')}),flush=True)
    page.goto(args.base_url+'/detect',wait_until='domcontentloaded');page.locator('input[type=file]').set_input_files({'name':'bad.txt','mimeType':'text/plain','buffer':b'invalid'})
    text=page.locator('body').inner_text();records.append({'id':'unsupported','pass':'Unsupported format' in text,'rendered_text':text,'analyse_disabled':page.get_by_role('button',name='Analyse video').is_disabled()});page.screenshot(path=str(OUT/'unsupported-result.png'),full_page=True)
    page.locator('input[type=file]').set_input_files({'name':'corrupt.mp4','mimeType':'video/mp4','buffer':b'not video'});page.get_by_role('button',name='Analyse video').click();page.get_by_text('Media validation failed:',exact=False).wait_for(timeout=20000)
    text=page.locator('body').inner_text();records.append({'id':'corrupt','pass':'Media validation failed:' in text,'rendered_text':text});page.screenshot(path=str(OUT/'corrupt-result.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(OUT/'mobile-error.png'),full_page=True);records.append({'id':'mobile-width','pass':page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'width':390})
    save();context.close();browser.close()
    if errors or any(not record['pass'] for record in records):
        raise SystemExit(1)
