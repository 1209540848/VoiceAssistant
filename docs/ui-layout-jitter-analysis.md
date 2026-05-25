# UI Layout Jitter Analysis

## Problem

Clicking navigation items caused visible jitter, especially when switching to Settings or Feedback.

This was not a content-size problem in a single page. The actual problem was that the app did not have one stable desktop canvas.

## Cause

Three things made the visible layout change during page switching:

- The Electron main window could be resized below the intended desktop width.
- The CSS breakpoint below `1120px` could switch the desktop layout into a narrow responsive layout.
- Some pages had vertical scrolling while others did not, so the content width changed when the scrollbar appeared or disappeared.

The result was that every page looked like it had a slightly different size.

## Fix

- Lock the Electron main window to `1180 x 640` for the MVP desktop shell.
- Set `minWidth` to the same value and disable resizing.
- Keep `.desktop-shell`, `.sidebar`, `.content-shell`, and `.page-view` on one fixed `100vh` canvas.
- Use internal page scrolling instead of changing the window size.
- Always reserve scrollbar space with `overflow-y: scroll` and `scrollbar-gutter: stable`.
- Restrict narrow responsive layout rules to coarse pointer devices so they do not affect the desktop app.

## Why This Fix

The desktop app should behave like a tool window, not a web page that reflows on every section. Navigation should only change content, not the outer frame, sidebar, or working canvas.
