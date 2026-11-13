import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { StreetMap } from './StreetMap';
import { useMedia } from './components';

type MapProps = Omit<Parameters<typeof StreetMap>[0], 'padding'>;

/** Full-bleed map with a floating top bar and a bottom sheet (phones) / side panel (≥820px). Keeps the map's
 *  focus area clear of the sheet so pins and routes are never hidden behind it. */
export function MapShell({ map, top, sheet, sheetClass }: { map: MapProps; top?: ReactNode; sheet: ReactNode; sheetClass?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [h, setH] = useState(300);
  const wide = useMedia('(min-width: 820px)');
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.round(el.getBoundingClientRect().height / 20) * 20));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padding = wide ? { top: 96, left: 470, right: 70, bottom: 40 } : { top: 96, left: 56, right: 64, bottom: h + 24 };
  return (
    <div className="r-app">
      <StreetMap {...map} padding={padding} />
      {top && <div className="r-topbar">{top}</div>}
      <section ref={ref} className={`r-sheet ${sheetClass ?? ''}`}>
        <div className="r-grabber" aria-hidden />
        <div className="r-sheet-body">{sheet}</div>
      </section>
    </div>
  );
}
