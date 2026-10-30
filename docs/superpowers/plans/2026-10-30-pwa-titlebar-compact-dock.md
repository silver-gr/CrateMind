# PWA titlebar and compact dock

Completed source changes on2026-10-30. No production/native build, packaging, restart, commit, library scan or sourceaudio/database mutation inthisround.

- Progressive installed ChromiumPWAstrip uses browsergeometry, safe drag region, theme-color-matched edgegradient andtransparentcenter. Normalbrowser/native/fullscreen/offstates reservezeroextraheight. Userconfirmed actualBravecontrolslooksmoothwiththegradient.
- Shared dock height136..170px (default170); waveform capped800x130px. Centeredcontentmax1800px, withbalancedouterwhitespace. Compared150x50 and160x60pads; selected160x60forreadability/alignment. The2x4bank topsout664x128px andshrinksresponsivelyin narrowerwindows.
- Shared36px neutral circularsidebarbuttons; Imageiconforbackground; only6px outlineedge dotforenabled audioprocessing, withaccessiblestate description.

Verification: no-emittypecheck and171frontendtests; actualbrowser2304px measuredpads160x60,dock170,wave800x130; 1440/1280/800pxnoflowoverflow; dark/lightcontrolschecked; labelledPWAemulationverified32pxsafestrip,correctdragrect,theme-colorupdateandzerogapwhenoff. ActualBrave appearanceconfirmedbyuser; Chrome/Chromiuminstalledwindowdragnotseparatelyexercised.
