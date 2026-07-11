// Exact port of the reactive-haptics chain embedded in the Windows helper
// (Program.cs ProcessReactiveHapticsSample and its coefficient tables). Any
// change here must be mirrored there — the two paths must feel identical.
sealed class ReactiveHapticsDsp
{
    private float filterLeft;
    private float filterRight;
    private float envelopeLeft;
    private float envelopeRight;
    private float gate;
    private float outputRamp;

    private volatile int gainPercent = 100;
    private volatile int bassFocus = 1;
    private volatile int response = 1;
    private volatile int attack = 1;
    private volatile int release = 1;

    public ReactiveHapticsDsp(int gainPercent, int bassFocus, int response, int attack, int release)
    {
        Configure(gainPercent, bassFocus, response, attack, release);
    }

    public void Configure(int gainPercent, int bassFocus, int response, int attack, int release)
    {
        this.gainPercent = Math.Clamp(gainPercent, 0, 200);
        this.bassFocus = bassFocus;
        this.response = response;
        this.attack = attack;
        this.release = release;
        filterLeft = 0;
        filterRight = 0;
        envelopeLeft = 0;
        envelopeRight = 0;
        gate = 0;
        outputRamp = 0;
    }

    public (float Left, float Right) ProcessSample(float left, float right)
    {
        var coeff = FilterCoeff(bassFocus);
        filterLeft += (left - filterLeft) * coeff;
        filterRight += (right - filterRight) * coeff;
        envelopeLeft = FollowEnvelope(envelopeLeft, filterLeft, attack, release);
        envelopeRight = FollowEnvelope(envelopeRight, filterRight, attack, release);

        var peak = Math.Max(envelopeLeft, envelopeRight);
        var gateTarget = peak > AudioConstants.HapticsGateThreshold ? 1.0f : 0.0f;
        var gateRate = gateTarget > gate
            ? AudioConstants.HapticsGateOpenRate
            : AudioConstants.HapticsGateCloseRate;
        gate += (gateTarget - gate) * gateRate;
        outputRamp = Math.Min(1.0f, outputRamp + AudioConstants.HapticsOutputRampStep);

        var gain = (gainPercent / 100.0f)
            * FocusGain(bassFocus)
            * gate
            * outputRamp;
        gain *= ResponseGain(response);
        var punch = ResponsePunch(response);
        return (
            SoftClipUnit(filterLeft * gain * EnvelopePunch(envelopeLeft, punch)),
            SoftClipUnit(filterRight * gain * EnvelopePunch(envelopeRight, punch))
        );
    }

    private static float FilterCoeff(int bassFocus)
    {
        return bassFocus switch
        {
            0 => 0.01039f,
            2 => 0.03095f,
            3 => 0.05123f,
            _ => 0.02074f
        };
    }

    private static float FollowEnvelope(float current, float value, int attack, int release)
    {
        var target = Math.Abs(value);
        var rate = target > current
            ? AttackCoeff(attack)
            : ReleaseCoeff(release);
        return current + ((target - current) * rate);
    }

    private static float AttackCoeff(int attack)
    {
        return attack switch
        {
            0 => 0.20f,
            2 => 0.65f,
            3 => 0.90f,
            _ => AudioConstants.HapticsEnvelopeAttack
        };
    }

    private static float ReleaseCoeff(int release)
    {
        return release switch
        {
            0 => 0.055f,
            2 => 0.012f,
            3 => 0.006f,
            _ => AudioConstants.HapticsEnvelopeRelease
        };
    }

    private static float SoftClipUnit(float value)
    {
        var x = Math.Clamp(value, -4.0f, 4.0f);
        var x2 = x * x;
        return Math.Clamp((x * (27.0f + x2)) / (27.0f + (9.0f * x2)), -1.0f, 1.0f);
    }

    private static float FocusGain(int bassFocus)
    {
        return bassFocus switch
        {
            0 => 1.35f,
            2 => 1.12f,
            3 => 0.92f,
            _ => 1.0f
        };
    }

    private static float ResponseGain(int response)
    {
        return response switch
        {
            0 => 0.68f,
            2 => 1.0f,
            _ => 1.0f
        };
    }

    private static float ResponsePunch(int response)
    {
        return response switch
        {
            0 => 0.0f,
            2 => 3.0f,
            _ => 1.5f
        };
    }

    private static float EnvelopePunch(float envelope, float punch)
    {
        return 1.0f + (punch * Math.Clamp(envelope, 0.0f, 1.0f));
    }
}
