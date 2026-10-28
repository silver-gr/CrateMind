import subprocess
import sys
import threading

import pytest

from app.services.media_tools import ToolRunner


def test_absolute_media_process_works_without_path_and_bounds_output(monkeypatch):
    monkeypatch.setenv("PATH", "")
    runner = ToolRunner(output_limit=4096)
    result = runner.run(sys.executable, ["-c", "print('fixture')"], timeout_s=3)
    assert result.stdout == b"fixture\n" and result.returncode == 0
    with pytest.raises(ValueError):
        runner.run(sys.executable, ["-c", "print('x'*100000)"], timeout_s=3)
    assert not runner._children


def test_timeout_cancellation_and_shutdown_reap_processes():
    runner = ToolRunner()
    with pytest.raises(subprocess.TimeoutExpired):
        runner.run(sys.executable, ["-c", "import time;time.sleep(10)"], timeout_s=.1)
    assert not runner._children
    canceled = threading.Event()
    canceled.set()
    with pytest.raises(OSError):
        runner.run(sys.executable, ["-c", "import time;time.sleep(10)"], timeout_s=3, cancel_event=canceled)
    with runner.process([sys.executable, "-c", "import time;time.sleep(10)"]) as process:
        runner.stop_all()
        assert process.poll() is not None
    with pytest.raises(OSError):
        runner.run(sys.executable, ["-c", "print('must not start')"], timeout_s=1)
    assert not runner._children


def test_concurrency_budget_is_shared_across_run_and_streaming():
    runner = ToolRunner(concurrency=1)
    entered, done = threading.Event(), threading.Event()
    def second():
        entered.set()
        runner.run(sys.executable, ["-c", "pass"], timeout_s=3)
        done.set()
    with runner.process([sys.executable, "-c", "import time;time.sleep(10)"]):
        thread = threading.Thread(target=second)
        thread.start()
        assert entered.wait(1)
        assert not done.wait(.1)
        assert len(runner._children) == 1
    thread.join(3)
    assert done.is_set() and not runner._children
