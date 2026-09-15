#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-rtmidi==1.5.8"]
# ///
"""Send controls to the prepared Ableton set. See docs/ABLETON.md."""
import argparse
import math
import time

CONTROLS = {"vocals": 20, "space": 21, "stutter": 22, "gain": 23}
DEFAULT_PORT = "IAC Driver LiveMixer"
STATUS = 0xBF  # CC, channel 16 (no notes, clock or transport messages)


def unit_value(text):
    value = float(text)
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise argparse.ArgumentTypeError("Use a finite value from 0 to 1.")
    return value


def main():
    import rtmidi

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=DEFAULT_PORT, help="Exact MIDI output name")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("ports", help="List available MIDI outputs")
    send = commands.add_parser("send", help="Set one continuous control (0..1)")
    send.add_argument("control", choices=["vocals", "space", "stutter", "gain"])
    send.add_argument("value", type=unit_value)
    learn = commands.add_parser("learn", help="Send a single CC for Live's MIDI learn mode")
    learn.add_argument("control", choices=CONTROLS)
    commands.add_parser("reset", help="Full vocals, dry effects, no stutter, unity mix gain")
    commands.add_parser("pulse", help="Legacy direct-Repeat test only; use send stutter with Beat Cycle")
    args = parser.parse_args()
    midi = rtmidi.MidiOut()
    ports = midi.get_ports()
    if args.command == "ports":
        print("\n".join(ports) or "No MIDI outputs available.")
        return
    if args.port not in ports:
        parser.error(f"MIDI output {args.port!r} is unavailable. Run 'ports' to list outputs.")
    midi.open_port(ports.index(args.port), "LiveMixer controls")

    def cc(name, value):
        midi.send_message([STATUS, CONTROLS[name], value])

    try:
        if args.command == "send":
            cc(args.control, round(args.value * 127))
        elif args.command == "learn":
            cc(args.control, 0)
        elif args.command == "reset":
            for name, value in [("stutter", 0), ("space", 0), ("vocals", 127), ("gain", 127)]:
                cc(name, value)
        elif args.command == "pulse":
            parser.error("The new set maps CC22 to Amount. Use 'send stutter 1', then 'send stutter 0'.")
        time.sleep(0.1)
    finally:
        midi.close_port()


if __name__ == "__main__":
    main()
