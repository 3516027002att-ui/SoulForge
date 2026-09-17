/*
 * SoulForge's embedded Sekiro HKS compiler configuration.
 *
 * The compiler is built for the Sekiro 1.6.x bytecode dialect.  It is a
 * native library loaded by SoulForge.Bridge from its own resources; it never
 * probes a game/tools directory or an editor installation.
 */
#ifndef HCONFIG_H
#define HCONFIG_H

#define HKSC_COMPATIBILITY_BIT_MEMOIZATION 0
#define HKSC_COMPATIBILITY_BIT_STRUCTURES 1
#define HKSC_COMPATIBILITY_BIT_SELF 2
#define HKSC_COMPATIBILITY_BIT_DOUBLES 3
#define HKSC_COMPATIBILITY_BIT_NATIVEINT 4

#define HKSC_NO_COMPAT_VARARG
#undef HKSC_UI64API
#undef HKSC_EMU_UI64
#undef HKSC_DECOMPILER
#undef LUA_CODIW6
#undef LUA_CODT6
#undef LUA_CODT7
#define HKSC_FROMSOFT_TTABLES
#define HKSC_TABLESIZE_EXTENSION

#define HKSC_GETGLOBAL_MEMOIZATION 1
#define HKSC_STRUCTURE_EXTENSION_ON 1
#define HKSC_SELF 0
#define HKSC_WITHDOUBLES 0
#define HKSC_WITHNATIVEINT 0

#undef HKSC_TESTING
#undef HKSC_TEST_WITH_STANDARD_LUA
#undef HKSC_NO_RK

#endif
