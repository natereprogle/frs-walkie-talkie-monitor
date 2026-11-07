# FRS Walkie-Talkie & CTCSS/DCS SDR Monitor

A real-time, zero-dependency Node.js application that turns a cheap Nooelec or RTL-SDR USB dongle into a multi-channel **FRS (Family Radio Service) scanner and digital/analog privacy code decoder**. 

Designed specifically to monitor and inspect consumer walkie-talkies (such as Onn, Motorola, or Midland 22-channel FRS radios) by decoding **CTCSS (Continuous Tone-Coded Squelch System)** analog sub-audible tones and **DCS (Digital-Coded Squelch)** bitstreams on the fly.

# Why?
I got my daughter these **[onn Kids Walkies 2Pack](https://www.walmart.com/ip/onn-Kids-Walkie-Talkies-Up-to-16-Mile-Range-22-Channels-LED-Flashlight-2-Pack/18468554024)** at Walmart. They claimed to have "Privacy Codes" built into them, but encryption on FRS radio channels is actually illegal under [47 CFR 95.381](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-95/subpart-A/section-95.381). In the manual, if you look closely, it specifically says "Interference Eliminator Codes".

So, since I have a Nooelec SDR just laying around, I figured I'd see if I can make a way to scan, detect, and decode signals from these talkies! The channels and their frequencies are included in the manual, but the CTCSS/DCS codes (specifically the DCS codes) are not. As well, the DCS codes in the walkies' firmware don't match actual codes. For example, Privacy Code 39 is DCS Code 45 D047, Privacy Code 40 was DCS Code 72 D244I, etc. The webpage will display the real DCS code, not the onn equivalent.

This is **100% vibecoded** with Google Gemini 4 Argon (and, yes, I hit my limit on my **paid** Google AI Pro plan in ~20 minutes 😑). It was just a cool little experiment I wanted to try and did not intend or want to do much more with it.

The remaining Markdown file is also AI-generated. Enjoy!

---

## Features

- **22-Channel Dashboard:** Clean, responsive web UI displaying live signal strength (RMS), active transmission states, and detected privacy codes across all standard FRS channels.
- **Pure JavaScript DSP Engine:** Built entirely in modern Node.js with zero external `npm` dependencies. Features a Goertzel filter bank for CTCSS tone identification and a Zero-Crossing Digital PLL with Golay (23,12) syndrome decoding for DCS bitstreams.
- **Live Browser Audio Streaming:** Streams baseband audio over Server-Sent Events (SSE) directly to the browser using the Web Audio API, complete with a **300 Hz high-pass filter** that strips out the annoying sub-audible CTCSS/DCS hum—just like a real walkie-talkie speaker.
- **Hardware Squelch & FM Quieting Gates:** Built-in noise-floor and carrier-detect logic to eliminate ghost code triggers from static noise.
- **Robust Process Management:** Clean `SIGINT` lifecycle handling to prevent USB bus lockups (`libusb` timeout errors) when switching channels or running automated scans.

---

## Prerequisites & Hardware

1. **RTL-SDR USB Dongle:** (e.g., Nooelec NESDR SMArt, Mini, or any RTL2832U-based receiver).
2. **USB Connection Tip:** Plug the SDR **directly into your computer or a powered USB hub**. Passive USB extension cables can cause voltage drops that crash the RTL2832U microcontroller during USB enumeration.

### Installing `librtlsdr` Binaries

The script spawns the standard `rtl_fm` command-line utility to stream raw PCM audio from your SDR dongle.

* **macOS (Homebrew):**
  ```bash
  brew install librtlsdr
  ```
* **Linux (APT):**
  ```bash
  sudo apt install rtl-sdr
  ```
* **Windows**:
  1. Replace the default Windows TV driver with WinUSB using [Zadig](https://zadig.akeo.ie/) (select Bulk-In, Interface 0).
  2. Download the official Windows binaries (Release.zip) from the [RTL-SDR Blog Releases](https://github.com/rtlsdrblog/rtl-sdr-blog/releases/latest/download/Release.zip).
  3. Extract `rtl_fm.exe`, `rtlsdr.dll`, and `libusb-1.0.dll` directly into your project folder.

--- 

## Installation & Setup

1. Clone or download this repository into a local folder.
2. Ensure you have Node.js (v18+ or v24 LTS) installed.
3. Save the main server script as frs-dashboard.mjs.

---

## Running the Application

Start the server from your terminal:

```bash
node server.mjs
```

You will see output indicating the server has started:

```
🚀 FRS SDR Dashboard running at http://localhost:3000
```

Open your web browser and navigate to:

```
http://localhost:3000
```

---

## How to Use
1. **Select a Channel**: Click any channel card on the grid (e.g., CH 3) to instantly tune the SDR hardware to that frequency.
2. **Test a Walkie-Talkie**: Set your walkie-talkie to match the channel and press the PTT (Push-to-Talk) button near your SDR antenna.
3. **View Privacy Codes**:
  * CTCSS (Codes 1–38): The card will light up purple, displaying the exact sub-audible frequency in Hz (e.g., Code 5 • CTCSS 79.7 Hz).
  * DCS (Codes 39–121): The card will light up amber, displaying the decoded octal word (e.g., Code 48 • DCS D271).
  * Listen Live: Click the "**🔇 Live Audio: OFF**" button at the top header to toggle live audio streaming through your speakers. The built-in 300 Hz high-pass filter will automatically mute the sub-audible tones while keeping voices crystal clear.
Auto-Scan Mode: Click "Auto-Scan: OFF" to cycle through all 22 FRS channels automatically, pausing when a transmission breaks squelch.

---

## Project Structure

* server.mjs: Single-file Node.js server containing:
  * Child process manager (`rtl_fm` interface with safe `SIGINT` teardown).
  * High-performance Goertzel algorithm implementation for frequency analysis.
  * 134.4 bps clock-recovery loop and Golay(23,12) error-correcting decoder for DCS.
  * SSE data pipeline broadcasting state and audio chunks.
  * Single-page embedded HTML/CSS/JS frontend UI.

---

## License
MIT License — feel free to fork, experiment, and modify for your own radio projects!
