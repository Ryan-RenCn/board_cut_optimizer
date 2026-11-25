# Embedded resources

`NotoSansSC.ttf` is a static Regular (weight 400) instance of the official Google Fonts Noto Sans SC variable font:
https://github.com/google/fonts/tree/main/ofl/notosanssc

Prepared with fontTools `instantiateVariableFont(..., {"wght": 400})` to provide a regular weight in egui and consistent GDI font embedding. No Python/fontTools dependency is needed at runtime. Redistribution terms are in `OFL.txt`; the same license is embedded and accessible from the application.

The Windows application icon is taken from the existing project's `assets/app-icon.ico` and embedded by `build.rs`.
