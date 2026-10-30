using System.Runtime.InteropServices;

// Route fatal signals into the same graceful stop the stdin-EOF path uses.
//
// The companion stops a helper by closing its stdin and escalating to
// SIGTERM/SIGKILL if it lingers; a session logout delivers SIGTERM or SIGHUP
// directly. .NET's default SIGTERM disposition tears the process down without
// ever returning from the run loop, so the code that kills the pw-record /
// pw-play children never ran -- every stop orphaned them as lingering pw-cat
// streams (issue #3). With these registrations the signal just sets the stop
// flag; the run loop exits on its own and reaps its children.
static class LinuxShutdownSignals
{
    public static IDisposable Register(Action stop)
    {
        return new Disposer(new[]
        {
            PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => { context.Cancel = true; stop(); }),
            PosixSignalRegistration.Create(PosixSignal.SIGINT, context => { context.Cancel = true; stop(); }),
            PosixSignalRegistration.Create(PosixSignal.SIGHUP, context => { context.Cancel = true; stop(); })
        });
    }

    private sealed class Disposer(IDisposable[] registrations) : IDisposable
    {
        public void Dispose()
        {
            foreach (var registration in registrations)
            {
                registration.Dispose();
            }
        }
    }
}
