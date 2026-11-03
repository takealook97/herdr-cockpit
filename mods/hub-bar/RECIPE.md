# hub broadcast bar

A 44 px strip has a title, horizontally scrolling Head chips with status dots, page controls after nine Heads, a retained Input and Send, and a close control. Stop mouse propagation on controls. Chips toggle exclusion from broadcast; unseen Heads default to included. Selection covers every page.

Enter or Send sends literal text using hc(["send", address, text]); hc send includes Enter. More than one recipient requires a second submit with unchanged text and target order. Editing, chip selection or Esc disarms confirmation. Reject empty/stale/zero-target sends and duplicate submissions in flight. No force flag, shell interpolation or automatic retries. Report partial failures, retain the draft, and tell the user to retry individually. Input text is never persisted; grid updates and switching stack children preserve the mounted composer draft. The close control returns to work-normal. Keep pure model.js byte-identical to space-tree/hub-model.js.

Test selection, confirmation invalidation, literal arguments, stale metadata, concurrent submits and partial failures using fake hc only.
