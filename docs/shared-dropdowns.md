# Shared dropdown control

All single-choice selects in the POS share `public/select-control.js` and
`public/select-control.css`. The root `SelectControls` component installs the
enhancement for React screens, legacy views and dynamically created editors.
The public customer menu loads the same module and stylesheet with light-theme
tokens. Multiple-selection listboxes keep their native behaviour.

Desktop uses a bounded popup. Phones use a bottom sheet, initially focused on
the options so opening it does not raise the keyboard. Lists longer than seven
options get search. Groups, disabled options, selected marks, empty results,
keyboard navigation, Escape and Tab are supported. Native dialogs keep the
picker above existing editors or filter sheets.

The original select remains in its original DOM parent with its ID, name,
options, validation and value. The shared control emits input/change only when
the selection changes. Programmatic value/index changes, option updates,
controlled React selections, disabled fieldsets and form resets refresh the
display. No duplicate state or new backend write path is introduced. A
`data-native-select` attribute opts a select out if needed.

Validation: production build, 178 frontend tests, dropdown browser tests and the
existing phone/login/payment regression suite. Local integration checks cover
the product editor, a controlled React payment filter and the public menu.
Inventory startup also waits for branch identity and ignores discarded refresh
results, preventing a missing branch or an old request from breaking Actions.

Deployed to Firebase Hosting on 10 November 2026. Live integration checks passed
for the product editor, React payment filter and public-menu branch control.
No products, orders or payments were created during verification.
