using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

class Program
{
    static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        string lang = args.Length > 0 ? args[0] : "ja";

        // Read PNG bytes from stdin
        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            using var stdin = Console.OpenStandardInput();
            stdin.CopyTo(ms);
            bytes = ms.ToArray();
        }

        if (bytes.Length == 0)
        {
            Console.Out.Write("{\"error\":\"no input\"}");
            return 1;
        }

        try
        {
            // Load PNG into WinRT InMemoryRandomAccessStream (no temp file)
            var ras = new InMemoryRandomAccessStream();
            using (var writer = new DataWriter(ras))
            {
                writer.WriteBytes(bytes);
                await writer.StoreAsync();
                await writer.FlushAsync();
                writer.DetachStream();
            }
            ras.Seek(0);

            // Decode to SoftwareBitmap in the format OcrEngine requires
            var decoder = await BitmapDecoder.CreateAsync(ras);
            // Use Ignore alpha so PrintWindow output (where alpha=0) is not zeroed out
            var bitmap = await decoder.GetSoftwareBitmapAsync(
                BitmapPixelFormat.Bgra8,
                BitmapAlphaMode.Ignore);

            // Create OCR engine — try requested language, fall back to profile languages
            var engine = OcrEngine.TryCreateFromLanguage(new Language(lang))
                         ?? OcrEngine.TryCreateFromUserProfileLanguages();

            if (engine == null)
            {
                Console.Out.Write("{\"error\":\"OCR language pack not installed for: " + EscapeJson(lang) + "\"}");
                return 2;
            }

            var ocrResult = await engine.RecognizeAsync(bitmap);

            var words = new List<string>();
            foreach (var line in ocrResult.Lines)
            {
                foreach (var word in line.Words)
                {
                    var r = word.BoundingRect;
                    // Round (not truncate) to avoid accumulated bbox drift
                    int x = (int)Math.Round(r.X);
                    int y = (int)Math.Round(r.Y);
                    int w = Math.Max(1, (int)Math.Round(r.Width));
                    int h = Math.Max(1, (int)Math.Round(r.Height));
                    words.Add(
                        "{\"text\":" + EscapeJson(word.Text) +
                        ",\"bbox\":{\"x\":" + x +
                        ",\"y\":" + y +
                        ",\"width\":" + w +
                        ",\"height\":" + h + "}}");
                }
            }

            Console.Out.Write("{\"words\":[" + string.Join(",", words) + "]}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Out.Write("{\"error\":" + EscapeJson(ex.Message) + "}");
            return 3;
        }
    }

    static string EscapeJson(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n");  break;
                case '\r': sb.Append("\\r");  break;
                case '\t': sb.Append("\\t");  break;
                default:
                    if (c < 0x20)
                        sb.Append($"\\u{(int)c:x4}");
                    else
                        sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
