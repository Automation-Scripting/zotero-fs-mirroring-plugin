/* global pref */

// Diretório raiz no filesystem onde o espelhamento acontece
pref("extensions.fs-mirroring.rootDir", "");

// Modo seguro: não escreve nada no FS, só loga
pref("extensions.fs-mirroring.dryRun", false);

// Nome da pasta de lixo interno
pref("extensions.fs-mirroring.safeTrashDirName", "_FSMirror_Trash");

// Verbosidade extra (opcional)
pref("extensions.fs-mirroring.debug", true);