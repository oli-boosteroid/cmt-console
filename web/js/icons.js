/* Inline SVG icon set - stroke, currentColor, no emoji.
   Values are the inner markup of a 24x24 viewBox svg.
   v3 "console" set: chamfered 45-degree corners instead of rounded ones,
   square caps and mitred joins (set in ic()), and a solid 2px "pixel"
   where an icon has a point (eyes, LEDs, buttons, dots). One stroke, one size. */
(function () {
  function px(x, y) { return '<rect x="' + x + '" y="' + y + '" width="2.2" height="2.2" fill="currentColor" stroke="none"/>'; }
  window.ICONS = {
    inbox:   '<path d="M3 13l3-8h12l3 8v5l-3 3H6l-3-3z"/><path d="M3 13h5l1.5 3h5l1.5-3h5"/>' + px(10.9, 8),
    mail:    '<path d="M6 5h12l3 3v8l-3 3H6l-3-3V8z"/><path d="M4 8.5l8 5 8-5"/>',
    posts:   '<path d="M6 4h12l3 3v7l-3 3h-8l-5 4v-4l-2-2V7z"/><path d="M8 9h8M8 12.5h5"/>',
    discord: '<path d="M4 7l3-3h10l3 3v7l-3 3h-6l-5 4v-4H7l-3-3z"/>' + px(7.9, 9.4) + px(13.9, 9.4),
    jira:    '<path d="M7 4h10l3 3v10l-3 3H7l-3-3V7z"/><path d="M9.5 4v16M14.5 4v16"/>' + px(5.9, 9),
    notes:   '<path d="M5 3h9l5 5v12l-1 1H6l-1-1z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 16.5h5"/>',
    channels:'<path d="M9 3h6l6 6v6l-6 6H9l-6-6V9z"/><path d="M3 12h18M12 3l-3.5 9L12 21M12 3l3.5 9L12 21"/>',
    search:  '<path d="M8.5 4h5L17 7.5v5L13.5 16h-5L5 12.5v-5z"/><path d="M16 15l4.5 4.5"/>',
    bell:    '<path d="M6 16v-6l2-4 2-2h4l2 2 2 4v6l2 2H4z"/><path d="M10 21h4"/>',
    sun:     '<path d="M10 8h4l2 2v4l-2 2h-4l-2-2v-4z"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>',
    moon:    '<path d="M13 3H9L4 8v8l5 5h6l5-5v-2h-4l-4-4V7z"/>',
    plus:    '<path d="M12 5v14M5 12h14"/>',
    link:    '<path d="M10 7H6l-3 3v4l3 3h4"/><path d="M14 7h4l3 3v4l-3 3h-4"/><path d="M8 12h8"/>',
    user:    '<path d="M10 4h4l2 2v4l-2 2h-4l-2-2V6z"/><path d="M4 21v-3l3-3h10l3 3v3"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    menu:    '<path d="M4 6h16M4 12h16M4 18h10"/>',
    back:    '<path d="M15 6l-6 6 6 6"/>',
    tag:     '<path d="M3 4v8l9 9 8-8-9-9H4z"/>' + px(6, 7),
    check:   '<path d="M4 12.5l5 5L20 6.5"/>',
    clock:   '<path d="M9 3h6l6 6v6l-6 6H9l-6-6V9z"/><path d="M12 7v5l3 3"/>',
    calendar:'<path d="M7 5h10l3 3v12H4V8z"/><path d="M4 10h16M8 3v4M16 3v4"/>' + px(13.9, 13.9),
    archive: '<path d="M3 4h18v4H3z"/><path d="M5 8v10l2 2h10l2-2V8M10 12h4"/>',
    star:    '<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6.1L12 16.4l-5.4 3 1.3-6.1-4.6-4.1 6.1-.6z"/>',
    send:    '<path d="M21 3L10 14M21 3l-6 18-5-7-7-5z"/>',
    shield:  '<path d="M12 3l8 3v6l-3 5-5 4-5-4-3-5V6z"/>',
    server:  '<path d="M5 5h16v6H3V7zM3 13h18v4l-2 2H3z"/>' + px(5.9, 6.9) + px(5.9, 14.9),
    gamepad: '<path d="M7 7h10l3 3 1 6-2 2h-2l-2-2H9l-2 2H5l-2-2 1-6z"/><path d="M8 10v4M6 12h4"/>' + px(14.4, 9.9) + px(16.4, 12.4),
    external:'<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
    x:       '<path d="M6 6l12 12M18 6L6 18"/>',
    copy:    '<path d="M9 9h11v8l-3 3H9z"/><path d="M5 15H4V7l3-3h8v1"/>',
    command: '<path d="M7 4h10l3 3v10l-3 3H7l-3-3V7z"/><path d="M8.5 9l3 3-3 3M13 15h3"/>',
    dots:    px(3.9, 10.9) + px(10.9, 10.9) + px(17.9, 10.9),
    reply:   '<path d="M9 6l-5 5 5 5"/><path d="M4 11h11l4 4v4"/>',
    refresh: '<path d="M19 9l-3-4H8L5 9v1"/><path d="M5 15l3 4h8l3-4v-1"/><path d="M16 9h3V6M8 15H5v3"/>',
    facebook:'<path d="M14 8.5V7c0-.8.5-1 1-1h1.5V3H14c-2 0-3.5 1.3-3.5 3.6V8.5H8.5v3h2V21h3.5v-9.5H16l.5-3z"/>',
    wrench:  '<path d="M15 3l-3 3v4l-8 8v2h2l8-8h4l3-3-1-1-3 3h-2l-1-1V7l3-3z"/>',
    filter:  '<path d="M4 5h16l-6 7v7l-4-2v-5z"/>',
    hash:    '<path d="M5 9h14M4 15h14M10 4L8 20M16 4l-2 16"/>',
    bolt:    '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
    beaker:  '<path d="M9 3h6M10 3v6L4 19l1 2h14l1-2-6-10V3"/><path d="M7 15h10"/>',
    book:    '<path d="M5 20V4l1-1h13v15H6l-1 1v1l1 1h13"/>',
    /* game card: a store card (cover + title lines) with a second card behind it */
    cards:   '<path d="M9 3h10l2 2v13l-2 2H9l-2-2V5z"/><path d="M7 8H5L3 10v9l2 2h9"/><path d="M7 11h14"/><path d="M10 14h6M10 17h4"/>' + px(16.9, 5.9),
    /* wishlist: a bookmark with a plus */
    wishlist:'<path d="M6 3h12l1 1v17l-7-4-7 4V4z"/><path d="M12 7v6M9 10h6"/>',
    /* new games testing: the same controller as Add Testing Session */
    gametest:'<path d="M7 7h10l3 3 1 6-2 2h-2l-2-2H9l-2 2H5l-2-2 1-6z"/><path d="M8 10v4M6 12h4"/>' + px(14.4, 9.9) + px(16.4, 12.4)
  };
})();
