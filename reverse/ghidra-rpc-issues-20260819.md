## ghidra-rpc Issue Report

**Date:** 2026-08-19  
**Binary:** SmartCUTPro.exe 2.5.1.1  
**Host:** Windows / PowerShell

### Bugs encountered

Running `uv run ghidra-rpc status --project <path>` fails during module import with `ModuleNotFoundError: No module named 'fcntl'`. The package imports `fcntl` unconditionally from `ghidra_rpc/session.py`, but Python on Windows does not provide that Unix-only module.

### Missing features

- Cross-platform process/session locking implementation for Windows.

### Suggestions

- Use a platform-neutral file lock library or conditionally use `msvcrt` on Windows.
- Add a Windows smoke test that imports the CLI and runs `status`.
