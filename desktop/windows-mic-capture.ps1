Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class WindowsMicCapture
{
    private const int CALLBACK_FUNCTION = 0x00030000;
    private const int WAVE_FORMAT_PCM = 1;
    private const int MMSYSERR_NOERROR = 0;
    private const int WIM_DATA = 0x3C0;
    private const int BUFFER_COUNT = 4;
    private const int BUFFER_SIZE = 3200;

    private static IntPtr waveInHandle = IntPtr.Zero;
    private static WaveInProc callback;
    private static AutoResetEvent waitHandle = new AutoResetEvent(false);
    private static bool running = true;
    private static Stream output;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct WaveInCaps
    {
        public ushort wMid;
        public ushort wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint dwFormats;
        public ushort wChannels;
        public ushort wReserved1;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WaveFormatEx
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WaveHeader
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    private delegate void WaveInProc(IntPtr hwi, int uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

    [DllImport("winmm.dll")]
    private static extern int waveInOpen(out IntPtr hWaveIn, int uDeviceID, ref WaveFormatEx lpFormat, WaveInProc dwCallback, IntPtr dwInstance, int dwFlags);

    [DllImport("winmm.dll")]
    private static extern int waveInGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Auto)]
    private static extern int waveInGetDevCaps(int uDeviceID, out WaveInCaps lpCaps, int uSize);

    [DllImport("winmm.dll")]
    private static extern int waveInPrepareHeader(IntPtr hWaveIn, IntPtr lpWaveInHdr, int uSize);

    [DllImport("winmm.dll")]
    private static extern int waveInAddBuffer(IntPtr hWaveIn, IntPtr lpWaveInHdr, int uSize);

    [DllImport("winmm.dll")]
    private static extern int waveInStart(IntPtr hWaveIn);

    [DllImport("winmm.dll")]
    private static extern int waveInStop(IntPtr hWaveIn);

    [DllImport("winmm.dll")]
    private static extern int waveInReset(IntPtr hWaveIn);

    [DllImport("winmm.dll")]
    private static extern int waveInUnprepareHeader(IntPtr hWaveIn, IntPtr lpWaveInHdr, int uSize);

    [DllImport("winmm.dll")]
    private static extern int waveInClose(IntPtr hWaveIn);

    public static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--list-devices")
        {
            return ListDevices();
        }

        int deviceId = -1;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--device")
            {
                int.TryParse(args[i + 1], out deviceId);
            }
        }

        output = Console.OpenStandardOutput();
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) {
            e.Cancel = true;
            running = false;
            waitHandle.Set();
        };

        WaveFormatEx format = new WaveFormatEx();
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 1;
        format.nSamplesPerSec = 16000;
        format.wBitsPerSample = 16;
        format.nBlockAlign = 2;
        format.nAvgBytesPerSec = 32000;
        format.cbSize = 0;

        callback = OnWaveIn;
        int result = waveInOpen(out waveInHandle, deviceId, ref format, callback, IntPtr.Zero, CALLBACK_FUNCTION);
        if (result != MMSYSERR_NOERROR)
        {
            Console.Error.WriteLine("waveInOpen failed: " + result);
            return result;
        }

        IntPtr[] headers = new IntPtr[BUFFER_COUNT];
        IntPtr[] buffers = new IntPtr[BUFFER_COUNT];
        int headerSize = Marshal.SizeOf(typeof(WaveHeader));

        try
        {
            for (int i = 0; i < BUFFER_COUNT; i++)
            {
                buffers[i] = Marshal.AllocHGlobal(BUFFER_SIZE);
                WaveHeader header = new WaveHeader();
                header.lpData = buffers[i];
                header.dwBufferLength = BUFFER_SIZE;
                header.dwBytesRecorded = 0;
                headers[i] = Marshal.AllocHGlobal(headerSize);
                Marshal.StructureToPtr(header, headers[i], false);
                waveInPrepareHeader(waveInHandle, headers[i], headerSize);
                waveInAddBuffer(waveInHandle, headers[i], headerSize);
            }

            result = waveInStart(waveInHandle);
            if (result != MMSYSERR_NOERROR)
            {
                Console.Error.WriteLine("waveInStart failed: " + result);
                return result;
            }

            while (running)
            {
                waitHandle.WaitOne(250);
            }
        }
        finally
        {
            if (waveInHandle != IntPtr.Zero)
            {
                waveInStop(waveInHandle);
                waveInReset(waveInHandle);
                for (int i = 0; i < BUFFER_COUNT; i++)
                {
                    if (headers[i] != IntPtr.Zero)
                    {
                        waveInUnprepareHeader(waveInHandle, headers[i], headerSize);
                        Marshal.FreeHGlobal(headers[i]);
                    }
                    if (buffers[i] != IntPtr.Zero)
                    {
                        Marshal.FreeHGlobal(buffers[i]);
                    }
                }
                waveInClose(waveInHandle);
            }
        }

        return 0;
    }

    private static int ListDevices()
    {
        int count = waveInGetNumDevs();
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Write("[");
        for (int i = 0; i < count; i++)
        {
            WaveInCaps caps;
            int result = waveInGetDevCaps(i, out caps, Marshal.SizeOf(typeof(WaveInCaps)));
            if (result != MMSYSERR_NOERROR) continue;
            if (i > 0) Console.Write(",");
            Console.Write("{\"id\":" + i + ",\"name\":\"" + EscapeJson(caps.szPname) + "\",\"channels\":" + caps.wChannels + "}");
        }
        Console.Write("]");
        return 0;
    }

    private static string EscapeJson(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void OnWaveIn(IntPtr hwi, int uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2)
    {
        if (uMsg != WIM_DATA || !running) return;

        int headerSize = Marshal.SizeOf(typeof(WaveHeader));
        WaveHeader header = (WaveHeader)Marshal.PtrToStructure(dwParam1, typeof(WaveHeader));
        if (header.dwBytesRecorded > 0)
        {
            byte[] data = new byte[header.dwBytesRecorded];
            Marshal.Copy(header.lpData, data, 0, data.Length);
            lock (output)
            {
                output.Write(data, 0, data.Length);
                output.Flush();
            }
        }

        header.dwBytesRecorded = 0;
        Marshal.StructureToPtr(header, dwParam1, false);
        waveInAddBuffer(hwi, dwParam1, headerSize);
    }
}
"@

$exitCode = [WindowsMicCapture]::Main($args)
exit $exitCode
