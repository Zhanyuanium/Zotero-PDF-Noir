pref("extensions.pdf-noir.enable", true);
// Sensitivity of the white-background-line-art classifier and transform,
// 0.0 (conservative) .. 1.0 (aggressive). Stored as a STRING because Firefox
// default prefs have no float type (a float literal would read back as int 0).
// 0.7 is the aggressive default (typical paper figures with colored curves on
// white are caught; lower it to keep more light tints).
pref("extensions.pdf-noir.sensitivity", "0.7");
