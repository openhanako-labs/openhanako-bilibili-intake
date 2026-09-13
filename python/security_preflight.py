"""Security preflight checks for the video intake plugin.

Performs safety checks on commands, paths, and URLs before execution.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any


class SecurityCheck:
    """Security check result."""
    def __init__(self, name: str, passed: bool, message: str, severity: str = "error"):
        self.name = name
        self.passed = passed
        self.message = message
        self.severity = severity  # "error", "warning", "info"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "message": self.message,
            "severity": self.severity,
        }


def check_utf8_encoding(text: str, name: str = "text") -> SecurityCheck:
    """Check if text is valid UTF-8."""
    try:
        text.encode("utf-8").decode("utf-8")
        return SecurityCheck(f"utf8_{name}", True, "Valid UTF-8 encoding")
    except UnicodeDecodeError as e:
        return SecurityCheck(f"utf8_{name}", False, f"Invalid UTF-8 encoding: {e}")


def check_command_injection(cmd: list[str]) -> SecurityCheck:
    """Check command list for injection attempts.

    Args:
        cmd: Command as list of strings (not shell string)

    Returns:
        SecurityCheck result
    """
    if not isinstance(cmd, list):
        return SecurityCheck("cmd_injection", False, "Command must be a list, not a string")

    # Check for shell metacharacters in arguments
    dangerous_patterns = [
        r"[;&|`$]",  # Shell metacharacters
        r"\$\(",  # Command substitution
        r"`",  # Backticks
        r"\|",  # Pipes
        r">",  # Redirections
        r"<",  # Redirections
    ]

    for i, arg in enumerate(cmd[1:], start=1):  # Skip command name
        for pattern in dangerous_patterns:
            if re.search(pattern, str(arg)):
                return SecurityCheck(
                    "cmd_injection",
                    False,
                    f"Dangerous pattern '{pattern}' found in argument {i}: {arg}",
                )

    return SecurityCheck("cmd_injection", True, "No injection patterns detected")


def check_path_safety(path: Path, allowed_dirs: list[Path] | None = None) -> SecurityCheck:
    """Check path for directory traversal and other safety issues.

    Args:
        path: Path to check
        allowed_dirs: Optional list of allowed parent directories

    Returns:
        SecurityCheck result
    """
    try:
        resolved = path.resolve()
    except Exception as e:
        return SecurityCheck("path_safety", False, f"Cannot resolve path: {e}")

    # Check for directory traversal
    if ".." in str(path):
        return SecurityCheck(
            "path_traversal",
            False,
            f"Directory traversal detected: {path}",
        )

    # Check for null bytes
    if "\x00" in str(path):
        return SecurityCheck(
            "null_byte",
            False,
            "Null byte in path",
        )

    # Check against allowed directories
    if allowed_dirs:
        is_allowed = any(
            str(resolved).startswith(str(allowed.resolve()))
            for allowed in allowed_dirs
        )
        if not is_allowed:
            return SecurityCheck(
                "path_allowed",
                False,
                f"Path not in allowed directories: {resolved}",
            )

    return SecurityCheck("path_safety", True, f"Path is safe: {resolved}")


def check_url_safety(url: str) -> SecurityCheck:
    """Check URL for safety issues.

    Args:
        url: URL to check

    Returns:
        SecurityCheck result
    """
    # Check for localhost/private IPs
    private_patterns = [
        r"localhost",
        r"127\.0\.0\.1",
        r"0\.0\.0\.0",
        r"::1",
        r"10\.",
        r"172\.(1[6-9]|2[0-9]|3[01])\.",
        r"192\.168\.",
    ]

    for pattern in private_patterns:
        if re.search(pattern, url, re.IGNORECASE):
            return SecurityCheck(
                "url_private",
                False,
                f"URL contains private/local address: {url}",
            )

    # Check for file:// protocol
    if url.startswith("file://"):
        return SecurityCheck(
            "url_file_protocol",
            False,
            "file:// protocol not allowed",
        )

    # Check for data: protocol
    if url.startswith("data:"):
        return SecurityCheck(
            "url_data_protocol",
            False,
            "data: protocol not allowed",
        )

    return SecurityCheck("url_safety", True, "URL is safe")


def check_ffmpeg_path() -> SecurityCheck:
    """Check if ffmpeg is in PATH and accessible."""
    import shutil
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return SecurityCheck("ffmpeg_path", True, f"ffmpeg found at: {ffmpeg_path}")
    else:
        return SecurityCheck("ffmpeg_path", False, "ffmpeg not found in PATH")


def check_ffprobe_path() -> SecurityCheck:
    """Check if ffprobe is in PATH and accessible."""
    import shutil
    ffprobe_path = shutil.which("ffprobe")
    if ffprobe_path:
        return SecurityCheck("ffprobe_path", True, f"ffprobe found at: {ffprobe_path}")
    else:
        return SecurityCheck("ffprobe_path", False, "ffprobe not found in PATH")


def check_whisper_available() -> SecurityCheck:
    """Check if whisper is available."""
    try:
        import whisper
        return SecurityCheck("whisper_available", True, "whisper module available")
    except ImportError:
        return SecurityCheck("whisper_available", False, "whisper module not installed")


def check_cuda_available() -> SecurityCheck:
    """Check if CUDA is available."""
    try:
        import torch
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0)
            return SecurityCheck("cuda_available", True, f"CUDA available: {device_name}")
        else:
            return SecurityCheck("cuda_available", False, "CUDA not available", severity="warning")
    except ImportError:
        return SecurityCheck("cuda_available", False, "torch not installed", severity="warning")


def run_preflight_checks(
    check_ffmpeg: bool = True,
    check_whisper: bool = True,
    check_cuda: bool = True,
) -> list[SecurityCheck]:
    """Run all preflight checks.

    Args:
        check_ffmpeg: Check for ffmpeg/ffprobe
        check_whisper: Check for whisper
        check_cuda: Check for CUDA

    Returns:
        List of SecurityCheck results
    """
    checks = []

    if check_ffmpeg:
        checks.append(check_ffmpeg_path())
        checks.append(check_ffprobe_path())

    if check_whisper:
        checks.append(check_whisper_available())

    if check_cuda:
        checks.append(check_cuda_available())

    return checks


def print_preflight_report(checks: list[SecurityCheck]) -> bool:
    """Print preflight check report.

    Args:
        checks: List of SecurityCheck results

    Returns:
        True if all critical checks passed
    """
    all_passed = True
    print("\n=== Security Preflight Report ===\n")

    for check in checks:
        status = "✓" if check.passed else "✗"
        severity_icon = {"error": "❌", "warning": "⚠️", "info": "ℹ️"}.get(check.severity, "")

        if not check.passed and check.severity == "error":
            all_passed = False

        print(f"{status} {severity_icon} {check.name}: {check.message}")

    print(f"\n{'All critical checks passed!' if all_passed else 'Some critical checks failed!'}")
    return all_passed


if __name__ == "__main__":
    checks = run_preflight_checks()
    success = print_preflight_report(checks)
    sys.exit(0 if success else 1)
