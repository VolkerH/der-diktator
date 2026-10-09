# Keyboard navigation (#31)

1. Extend actor-scoped preferences with a typed action catalog, portable bindings,
   backend validation and SQLite migration. Preserve existing ETag/default/reset rules.
2. Add a reusable keyboard module with discoverable help and editable saved mappings.
   Keep native controls, ordinary text editing and browser shortcuts; resolve focus after
   dialogs, dynamic lists and the mobile drawer.
3. Test application contracts through HTTP and keyboard interactions separately, run
   `make check`, capture a browser walkthrough and open an unmerged PR.

Research: WAI APG [keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
and [modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) prescribe
visible focus, native Tab/Shift+Tab, activation and Escape/return focus. ChatGPT
[search documentation](https://help.openai.com/en/articles/10056348-how-do-i-search-my-chat-history-in-chatgpt)
uses Ctrl/Cmd+K. That combination also invokes browser search on some browsers, so
this app uses Ctrl+Shift+2 for chat search and a consistent numbered shortcut
family. Users can choose supported alternatives or disable individual actions.

No editor/framework replacement is needed. Clients dispatch keys and own focus,
capture, selection and device actions. The server owns defaults, validation,
profile persistence and concurrency. Existing controls remain the exhaustive
keyboard path for dynamic recordings, groups, models and recovery actions.
