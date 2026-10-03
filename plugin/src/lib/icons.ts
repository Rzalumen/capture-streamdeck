/**
 * Original line-style icons, drawn for this plugin (24×24 grid, one consistent stroke).
 * No third-party, Capture or Vectorworks artwork. Each entry is the inner SVG markup;
 * `iconSvg` wraps it with the shared stroke style.
 */
const CAM = `<path d="M3.5 8.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 16v-6a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M16 12l5.5-3v8L16 14"/>`;
const CUBE = `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>`;

export const ICONS: Record<string, string> = {
  // --- plugin / generic
  plugin: `<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>`,
  command: `<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 10l3 2.2-3 2.2M13 14.6h3"/>`,
  unset: `<rect x="4" y="4" width="16" height="16" rx="3.5" stroke-dasharray="3 3"/><path d="M12 8.5v7M8.5 12h7"/>`,
  back: `<path d="M14.5 6l-6 6 6 6"/><path d="M9 12h10"/>`,
  more: `<path d="M6 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/>`,
  // --- view modes
  wireframe: `${CUBE}`,
  plot: `<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>`,
  live: `<path d="M9.5 3.5h5l-.9 3.8h-3.2z"/><path d="M10.4 7.3L6 20.5M13.6 7.3L18 20.5M7.5 17.5h9"/>`,
  custom: `<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="#121417"/><circle cx="15.5" cy="12" r="2" fill="#121417"/><circle cx="8" cy="17" r="2" fill="#121417"/>`,
  alpha: `<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M16 9.2c-1.6-2-4.1-1.6-5.4.4-1.4 2.1-1 5.2.9 5.9 1.9.6 3.6-1.2 4.4-3.7M16.4 8.6l-.6 6.4"/>`,
  beta: `<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M10 19V9.2C10 6.9 11.400 6 12.800 6c1.700 0 2.700 1.100 2.700 2.400 0 1.400-1.100 2.300-2.500 2.600 1.900.1 3.100 1.100 3.100 2.700 0 1.700-1.400 2.800-3.100 2.800-1.300 0-2.100-.4-3-1.100"/>`,
  gamma: `<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 7.500c1.600-.9 3.100-.4 3.700 1.400l1 3.300 1.900-4.700M12.700 12.200V18"/>`,
  // --- display
  grid: `<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>`,
  widgets: `<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>`,
  hidden: `<path d="M2.5 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.800"/><path d="M4.500 19.500l15-15"/>`,
  info: `<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500"/><circle cx="12" cy="7.800" r=".6" fill="currentColor"/>`,
  dim: `<circle cx="12" cy="12" r="8.500"/><path d="M12 3.500a8.500 8.500 0 0 0 0 17z" fill="currentColor" fill-opacity=".45"/>`,
  arrange: `<rect x="3.500" y="4" width="17" height="16" rx="1.500"/><path d="M12 4v16M3.500 12h17"/>`,
  fullscreen: `<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>`,
  // --- camera
  camera: `${CAM}`,
  "swing-top": `${CAM}<path d="M9 3.500V1.800M7.400 3.200L9 1.500l1.600 1.700" transform="translate(0 .5)"/>`,
  "swing-front": `<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3.600"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  "swing-right": `${CAM}<path d="M4 21h9M11 19l2 2-2 2" transform="translate(0 -1)"/>`,
  "swing-left": `${CAM}<path d="M13 21H4M6 19l-2 2 2 2" transform="translate(0 -1)"/>`,
  "swing-selection": `<path d="M4 8V5.500A1.500 1.500 0 0 1 5.500 4H8M16 4h2.500A1.500 1.500 0 0 1 20 5.500V8M20 16v2.500a1.500 1.500 0 0 1-1.500 1.500H16M8 20H5.500A1.500 1.500 0 0 1 4 18.500V16"/><circle cx="12" cy="12" r="2.500"/>`,
  "focus-selection": `<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2.500v4M12 17.500v4M2.500 12h4M17.500 12h4"/>`,
  "focus-all": `<path d="M4 8V5.500A1.500 1.500 0 0 1 5.500 4H8M16 4h2.500A1.500 1.500 0 0 1 20 5.500V8M20 16v2.500a1.500 1.500 0 0 1-1.500 1.500H16M8 20H5.500A1.500 1.500 0 0 1 4 18.500V16"/><rect x="8" y="8" width="3" height="3"/><rect x="13" y="8" width="3" height="3"/><rect x="8" y="13" width="3" height="3"/><rect x="13" y="13" width="3" height="3"/>`,
  position: `<path d="M12 21s-6.500-5.700-6.500-10.500a6.500 6.500 0 0 1 13 0C18.500 15.300 12 21 12 21z"/><circle cx="12" cy="10.500" r="2.300"/>`,
  positions: `<path d="M12 20s-5-4.500-5-8.500a5 5 0 0 1 10 0c0 4-5 8.500-5 8.500z"/><circle cx="12" cy="11.500" r="1.800"/><path d="M3.500 6.500h3M17.500 6.500h3" />`,
  store: `<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>`,
  // --- select / edit
  select: `<path d="M5 4l6.500 15 2.200-6.300L20 10.500z"/>`,
  "select-all": `<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.500"/><path d="M8.500 12.200l2.400 2.400 4.600-5"/>`,
  deselect: `<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.500"/><path d="M9 9l6 6M15 9l-6 6"/>`,
  "select-type": `<path d="M4 6h10M4 12h7M4 18h10"/><path d="M15.500 11l2.300 7 1.400-2.800 2.800-1.400z"/>`,
  "select-group": `<rect x="3.500" y="3.500" width="7" height="7" rx="1.500"/><rect x="13.500" y="13.500" width="7" height="7" rx="1.500"/><path d="M14 7h6.500M17 3.500v7M7 14v6.500M3.500 17h7"/>`,
  layer: `<path d="M12 4l9 4.500-9 4.500-9-4.500z"/><path d="M3 12.500l9 4.500 9-4.500M3 16.500l9 4.500 9-4.500"/>`,
  truss: `<path d="M3 8h18M3 16h18"/><path d="M3 8l3.500 8 3.500-8 3.500 8L17 8l4 8"/>`,
  navigator: `<rect x="3.500" y="4" width="17" height="16" rx="2"/><path d="M9 4v16M12 9h5M12 13h5"/>`,
  undo: `<path d="M8 6L4 10l4 4"/><path d="M4 10h9.500a5.500 5.500 0 0 1 0 11H10"/>`,
  redo: `<path d="M16 6l4 4-4 4"/><path d="M20 10h-9.500a5.500 5.500 0 0 0 0 11H14"/>`,
  save: `<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>`,
  "save-as": `<path d="M5 4h11l3 3v6M5 4v16h7"/><path d="M8 4v5h7V4"/><path d="M15.500 21l1-3.500 5-5 2.500 2.500-5 5z" transform="translate(-3 -1)"/>`,
  duplicate: `<rect x="8.500" y="8.500" width="12" height="12" rx="2"/><path d="M15.500 8.500V5.500a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>`,
  delete: `<path d="M4.500 7h15M9.500 7V4.500h5V7M6.500 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>`,
  cut: `<circle cx="6.500" cy="17.500" r="2.500"/><circle cx="17.500" cy="17.500" r="2.500"/><path d="M8.300 15.700L18 4M15.700 15.700L6 4"/>`,
  paste: `<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3.500h6V5M9 11h6M9 15h6"/>`,
  group: `<rect x="3.500" y="3.500" width="10" height="10" rx="1.500"/><rect x="10.500" y="10.500" width="10" height="10" rx="1.500"/>`,
  align: `<path d="M4 3.500v17"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>`,
  // --- patch & focus
  patch: `<circle cx="7" cy="12" r="2.800"/><circle cx="17" cy="12" r="2.800"/><path d="M9.800 12h4.400M2.500 12H4.200M19.800 12h1.700"/>`,
  sequential: `<path d="M5 6.500h3M5 12h3M5 17.500h3"/><path d="M12 6.500h7M12 12h7M12 17.500h7"/><path d="M4.500 3.500v3M4.500 9.500v2.500M4.500 15v2.500" />`,
  focus: `<circle cx="12" cy="12" r="8.500"/><circle cx="12" cy="12" r="4.500"/><circle cx="12" cy="12" r="1" fill="currentColor"/>`,
  "fixture-details": `<path d="M8 3.500h8l-1.200 5H9.200z"/><path d="M9.200 8.500L7.500 14h9l-1.700-5.500M9 14v3.500a3 3 0 0 0 6 0V14"/>`,
  unpatch: `<circle cx="6.500" cy="12" r="2.800"/><circle cx="17.500" cy="12" r="2.800"/><path d="M9.300 12h1.200M13.500 12h1.200M11 9.500l2 5"/>`,
  // --- tabs
  "tab-design": `<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>`,
  "tab-fixtures": `<path d="M8 3.500h8l-1.200 5H9.200z"/><path d="M9.200 8.500L7.500 15h9l-1.700-6.500M12 15v5.500M8.500 20.500h7"/>`,
  "tab-universes": `<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17M12 3.500c2.500 2.300 3.500 5.300 3.500 8.500s-1 6.200-3.500 8.500C9.500 18.200 8.500 15.200 8.500 12s1-6.200 3.500-8.500z"/>`,
  "tab-media": `<rect x="3.500" y="5" width="17" height="14" rx="2"/><path d="M10 9.300v5.400l4.500-2.700z"/>`,
  "tab-snapshots": `<rect x="3.500" y="6.500" width="17" height="13" rx="2"/><path d="M8.500 6.500l1.300-2.500h4.400l1.300 2.500"/><circle cx="12" cy="13" r="3.300"/>`,
  "tab-library": `<path d="M5 4h3.500v16H5zM10.500 4H14v16h-3.500z"/><path d="M16 5.500l3.200-.9 3 14.400-3.200.9z" transform="translate(-1 0)"/>`,
  tabs: `<path d="M3.500 9.500h17V19a1.500 1.500 0 0 1-1.500 1.500H5A1.500 1.500 0 0 1 3.500 19z"/><path d="M3.500 9.500V6A1.500 1.500 0 0 1 5 4.500h4.500L11.500 7H19A1.500 1.500 0 0 1 20.500 8.500v1"/>`,
  export: `<path d="M12 15V3.500M7.500 8L12 3.500 16.500 8"/><path d="M5 13.500V19a1.500 1.500 0 0 0 1.500 1.500h11A1.500 1.500 0 0 0 19 19v-5.500"/>`,
  image: `<rect x="3.500" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.700"/><path d="M4 17l5-4.500 3.500 3 3-2.500L20 16"/>`,
  render: `<rect x="3.500" y="5" width="17" height="14" rx="2"/><path d="M8 12l2.500 2.500L16 9.500"/>`,
  // --- fixtures (v0.4)
  "cat-fixtures": `<path d="M4.500 20.500h15M7 20.500V11M17 20.500V11"/><rect x="8.500" y="4.500" width="7" height="9.500" rx="2.500"/><path d="M12 14v3"/>`,
  "fx-select": `<path d="M8 7.500L3.500 12 8 16.500M16 7.500l4.500 4.500-4.500 4.500"/><circle cx="12" cy="12" r="2.500"/>`,
  "fx-pan": `<path d="M3.500 12h17M7 8.500L3.500 12 7 15.500M17 8.500l3.500 3.500-3.500 3.500"/>`,
  "fx-tilt": `<path d="M12 3.500v17M8.500 7L12 3.500 15.500 7M8.500 17l3.500 3.500 3.500-3.500"/>`,
  "fx-intensity": `<circle cx="12" cy="12" r="4"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M5.600 18.400l1.800-1.800M16.600 7.400l1.800-1.800"/>`,
  "fx-zoom": `<circle cx="10.500" cy="10.500" r="6"/><path d="M15 15l5.500 5.500M10.500 8v5M8 10.500h5"/>`,
  "fx-focus": `<path d="M4 8V5.500A1.500 1.500 0 0 1 5.500 4H8M16 4h2.500A1.500 1.500 0 0 1 20 5.500V8M20 16v2.500a1.500 1.500 0 0 1-1.500 1.500H16M8 20H5.500A1.500 1.500 0 0 1 4 18.500V16"/><circle cx="12" cy="12" r="3"/>`,
  "fx-iris": `<circle cx="12" cy="12" r="8.500"/><circle cx="12" cy="12" r="3.200"/><path d="M12 3.500v5.300M19.400 7.800l-4.600 2.700M19.400 16.200l-4.600-2.700"/>`,
  "fx-colour": `<path d="M12 3.500c3.500 4 6 6.800 6 10a6 6 0 0 1-12 0c0-3.200 2.500-6 6-10z"/><path d="M9 14a3 3 0 0 0 3 3"/>`,
  "fx-white": `<circle cx="12" cy="12" r="8.500"/><circle cx="12" cy="12" r="4.200"/>`,
  "fx-setup": `<path d="M4 7h9M18 7h2M4 12h3M12 12h8M4 17h11M20 17h0"/><circle cx="15.500" cy="7" r="2.200"/><circle cx="9.500" cy="12" r="2.200"/><circle cx="17.500" cy="17" r="2.200"/>`,
  "fx-release": `<path d="M12 3.500v8"/><path d="M7 6.500a7.500 7.500 0 1 0 10 0"/>`,
  "fx-home": `<path d="M4 11.500l8-7 8 7"/><path d="M6 10.500v9h12v-9"/><path d="M10 19.500v-5h4v5"/>`,
  "fx-attr": `<circle cx="12" cy="12" r="7.500"/><path d="M12 12l3.800-3.800"/><path d="M12 2.500v2M21.500 12h-2M12 21.500v-2M2.500 12h2"/>`,
  "fx-page-prev": `<rect x="3.500" y="5" width="17" height="14" rx="2"/><path d="M13.500 8.500L10 12l3.500 3.500"/>`,
  "fx-page-next": `<rect x="3.500" y="5" width="17" height="14" rx="2"/><path d="M10.500 8.500L14 12l-3.500 3.500"/>`,
  "fx-status": `<circle cx="12" cy="12" r="2"/><path d="M7.800 7.800a6 6 0 0 0 0 8.400M16.200 7.800a6 6 0 0 1 0 8.400M4.900 4.900a10 10 0 0 0 0 14.200M19.100 4.900a10 10 0 0 1 0 14.200"/>`,
  // --- folders (categories)
  "folder-view": `<path d="M3 7.500A1.500 1.500 0 0 1 4.500 6H9l2 2.500h8.500A1.500 1.500 0 0 1 21 10v8a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 18z"/><circle cx="12" cy="14" r="2.200"/>`,
  // --- dials
  exposure: `<circle cx="12" cy="12" r="4"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21M5.600 5.600l1.800 1.800M16.600 16.600l1.800 1.800M5.600 18.400l1.800-1.800M16.600 7.400l1.800-1.800"/>`,
  ambient: `<path d="M12 3.500a6 6 0 0 0-3.500 10.900V17h7v-2.600A6 6 0 0 0 12 3.500z"/><path d="M9.500 20h5"/>`,
  bloom: `<circle cx="12" cy="12" r="3.500"/><circle cx="12" cy="12" r="7" stroke-dasharray="1 3"/><circle cx="12" cy="12" r="9.500" stroke-dasharray="1 4.500"/>`,
  whitebalance: `<path d="M12 3.500c3 3.700 5.500 6.500 5.500 9.500a5.500 5.500 0 0 1-11 0c0-3 2.500-5.800 5.500-9.500z"/><path d="M9 14.500a3 3 0 0 0 3 2.500"/>`,
  fill: `<path d="M5 13l7-8 7 8z"/><path d="M12 5L7 13"/><path d="M5 17.500h14M7 20.500h10"/>`,
  hueclamp: `<circle cx="12" cy="12" r="8.500"/><path d="M12 3.500a8.500 8.500 0 0 1 8.500 8.500H12z" fill="currentColor" fill-opacity=".45"/>`,
  contrast: `<circle cx="12" cy="12" r="8.500"/><path d="M12 3.500v17a8.500 8.500 0 0 0 0-17z" fill="currentColor" fill-opacity=".6"/>`,
  saturation: `<path d="M12 3.500c3 3.700 6 6.500 6 10a6 6 0 0 1-12 0c0-3.500 3-6.300 6-10z"/><path d="M12 3.500v16" stroke-dasharray="2 2"/>`,
  flare: `<circle cx="12" cy="12" r="2.500"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.600 5.600l3.200 3.200M15.200 15.200l3.200 3.200M5.600 18.400l3.200-3.200M15.200 8.800l3.200-3.200"/>`,
  flareangle: `<path d="M4 18h16"/><path d="M4 18l12-9"/><path d="M11 18a7 7 0 0 0-2-5"/>`,
  flaresize: `<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 2.500"/>`,
  streaks: `<path d="M12 3v18M4.200 7.500l15.600 9M4.200 16.500l15.600-9"/>`,
  autoexposure: `<circle cx="12" cy="12" r="4"/><path d="M12 3v2.500M12 18.500V21M3 12h2.500M18.500 12H21"/><path d="M8.500 15.500L12 8.500l3.500 7M9.800 13.500h4.400"/>`,
  laser: `<path d="M3 15h9"/><path d="M12 15l9-9M12 15l9-4M12 15l9 1" stroke-dasharray="2 2"/><circle cx="12" cy="15" r="1.200" fill="currentColor"/>`,
  // --- category icons (one per catalog category; also the fallback glyph of commands without their own)
  "cat-view": `<rect x="3.5" y="5" width="17" height="13" rx="2"/><path d="M8 21h8M12 18v3"/><path d="M7 13.500l3-3.500 2.500 2.500 2-2.500 2.500 3.500"/>`,
  "cat-camera": `${CAM}`,
  "cat-select": `<path d="M5 4l6.500 15 2.200-6.300L20 10.500z"/><path d="M15 3.500h5.500V9" stroke-dasharray="2 2.500"/>`,
  "cat-edit": `<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>`,
  "cat-patch": `<circle cx="7" cy="12" r="2.800"/><circle cx="17" cy="12" r="2.800"/><path d="M9.800 12h4.400M2.500 12H4.200M19.800 12h1.700"/>`,
  "cat-navigate": `<circle cx="12" cy="12" r="8.500"/><path d="M15.500 8.500l-2 5-5 2 2-5z"/>`,
  "cat-window": `<rect x="3.500" y="4.500" width="17" height="15" rx="2"/><path d="M3.500 9h17M6.500 6.800h.01M9 6.800h.01"/>`,
  "cat-file": `<path d="M6 3.500h8l4 4V20.500H6z"/><path d="M14 3.500V8h4"/>`,
  "cat-look": `<path d="M3.500 17.500h17"/><path d="M7.500 17.500a4.500 4.500 0 0 1 9 0"/><path d="M12 5.500v3M4.800 9.300l2.100 2.100M19.200 9.300l-2.100 2.100"/>`,
  "cat-tabs": `<path d="M3.500 9.500h17V19a1.500 1.500 0 0 1-1.500 1.500H5A1.500 1.500 0 0 1 3.500 19z"/><path d="M3.500 9.500V6A1.500 1.500 0 0 1 5 4.500h4.500L11 7h8A1.500 1.500 0 0 1 20.500 8.500v1"/>`,
  copy: `<path d="M9 7.500h9a1.500 1.500 0 0 1 1.500 1.500v10A1.500 1.500 0 0 1 18 20.500H9A1.500 1.500 0 0 1 7.500 19V9A1.500 1.500 0 0 1 9 7.500z"/><path d="M15.500 7.500V5A1.500 1.500 0 0 0 14 3.500H6A1.500 1.500 0 0 0 4.500 5v10A1.500 1.500 0 0 0 6 16.500h1.500M10.500 12.500h6M10.500 16h6"/>`,
  import: `<path d="M12 3.500V15M7.500 10.500L12 15l4.500-4.500"/><path d="M5 13.500V19a1.500 1.500 0 0 0 1.500 1.500h11A1.500 1.500 0 0 0 19 19v-5.500"/>`,
  // --- connection
  connection: `<path d="M4.500 9.500a11 11 0 0 1 15 0M7.500 12.800a7 7 0 0 1 9 0M10.400 16a3 3 0 0 1 3.200 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>`,
};

export const ICON_NAMES = Object.keys(ICONS);

/** Command name → icon. Unknown commands fall back to the generic `command` icon. */
export function iconForCommand(path: string[]): string {
  const last = (path[path.length - 1] ?? "").replace(/(…|\.\.\.)$/, "").trim().toLowerCase();
  const menu = (path[0] ?? "").toLowerCase();
  const table: Record<string, string> = {
    wireframe: "wireframe",
    plot: "plot",
    live: "live",
    custom: "custom",
    "alpha view": "alpha",
    "beta view": "beta",
    "gamma view": "gamma",
    grid: "grid",
    widgets: "widgets",
    "hidden objects": "hidden",
    "fixture information": "info",
    "project information": "info",
    "dim background": "dim",
    quad: "arrange",
    wide: "arrange",
    "enter full screen|exit full screen": "fullscreen",
    "enter full screen": "fullscreen",
    "swing to top": "swing-top",
    "swing to front": "swing-front",
    "swing to right": "swing-right",
    "swing to left": "swing-left",
    "swing to selection": "swing-selection",
    "focus selection": "focus-selection",
    "focus all": "focus-all",
    "select all": "select-all",
    "deselect all": "deselect",
    "by fixture type": "select-type",
    "by fixture group": "select-group",
    "by layer": "layer",
    "fixtures on truss": "truss",
    "selection navigator": "navigator",
    "view navigator": "navigator",
    undo: "undo",
    redo: "redo",
    save: "save",
    "save as": "save-as",
    duplicate: "duplicate",
    delete: "delete",
    cut: "cut",
    paste: "paste",
    group: "group",
    align: "align",
    unit: "sequential",
    circuit: "sequential",
    patch: "patch",
    channel: "sequential",
    "p3 fixture number": "sequential",
    focus: "focus",
    "fixture details": "fixture-details",
    unpatch: "unpatch",
    "export focus sheets": "export",
    "export documentation": "export",
    "export presentation": "export",
    "focus sheets": "export",
    documentation: "export",
    presentation: "export",
    "save image": "image",
    "render image": "render",
  };
  const hit = table[last];
  if (hit) return hit;
  if (/^position \d$/.test(last)) return menu === "view" && path[1]?.toLowerCase().startsWith("store") ? "store" : "position";
  return "command";
}

export function iconSvg(name: string, size = 24, color = "currentColor", stroke = 1.6): string {
  const inner = ICONS[name] ?? ICONS.command;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
