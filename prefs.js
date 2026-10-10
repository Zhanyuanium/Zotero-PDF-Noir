pref("extensions.pdf-noir.enable", true);
// Sensitivity of the white-background-line-art classifier and transform,
// 0.0 (conservative) .. 1.0 (aggressive). Stored as a STRING because Firefox
// default prefs have no float type (a float literal would read back as int 0).
// 0.7 is the aggressive default chosen for M1.
pref("extensions.pdf-noir.sensitivity", "0.7");
