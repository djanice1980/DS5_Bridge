using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;

#pragma warning disable CA1416

static class ProcessIconDataUrlResolver
{
    private static readonly ConcurrentDictionary<string, string?> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static string? TryResolve(string? processPath)
    {
        if (string.IsNullOrWhiteSpace(processPath) || !File.Exists(processPath))
        {
            return null;
        }

        return Cache.GetOrAdd(processPath, ExtractIconDataUrl);
    }

    private static string? ExtractIconDataUrl(string processPath)
    {
        try
        {
            using var icon = Icon.ExtractAssociatedIcon(processPath);
            if (icon is null)
            {
                return null;
            }

            using var bitmap = icon.ToBitmap();
            using var stream = new MemoryStream();
            bitmap.Save(stream, ImageFormat.Png);
            return $"data:image/png;base64,{Convert.ToBase64String(stream.ToArray())}";
        }
        catch
        {
            return null;
        }
    }
}

#pragma warning restore CA1416
