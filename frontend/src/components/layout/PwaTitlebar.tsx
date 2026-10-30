import { useEffect, useState, type CSSProperties } from "react";
import { readPwaTitlebarGeometry, subscribePwaTitlebar } from "../../lib/pwaTitlebar";
import "./PwaTitlebar.css";

/** The browser owns its control patches; only the available overlay area drags. */
export default function PwaTitlebar() {
  const [geometry, setGeometry] = useState(readPwaTitlebarGeometry);
  useEffect(() => {
    const update = () => setGeometry(readPwaTitlebarGeometry());
    const unsubscribe = subscribePwaTitlebar(update);
    update();
    return unsubscribe;
  }, []);

  if (!geometry) return null;
  const style = {
    "--cm-pwa-geometry-x": `${geometry.x}px`,
    "--cm-pwa-geometry-y": `${geometry.y}px`,
    "--cm-pwa-geometry-width": `${geometry.width}px`,
    "--cm-pwa-geometry-height": `${geometry.height}px`,
  } as CSSProperties;

  return (
    <div className="cm-pwa-titlebar" data-pwa-titlebar aria-hidden="true" style={style}>
      <div className="cm-pwa-titlebar-drag" data-pwa-titlebar-drag />
    </div>
  );
}
