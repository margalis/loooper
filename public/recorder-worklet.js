// recorder-worklet.js
// Runs on the browser's audio thread (that is why it is plain JavaScript and lives
// in /public: the browser loads it as a separate file).
//
// Job: capture the microphone between two EXACT sample positions, so a loop starts
// and ends precisely on the bar lines no matter how busy the page is. The page asks
// "record from frame A to frame B"; this code copies exactly those samples.
//
// Messages in : { type: "record", id, startFrame, endFrame }
//               { type: "trim", id, endFrame }      finish earlier than planned
//               { type: "cancel", id }
//               { type: "peek", id }                send back a copy of what is captured so far
// Messages out: { type: "done", id, data }          the captured samples
//               { type: "peek", id, data }          a partial copy (answer to "peek")
//               { type: "level", peak }             mic loudness, for the meter

/* global currentFrame, registerProcessor */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.job = null;
    this.peak = 0;
    this.blocks = 0;

    this.port.onmessage = (event) => {
      const m = event.data;
      if (m.type === "record") {
        const length = Math.max(0, m.endFrame - m.startFrame);
        this.job = {
          id: m.id,
          startFrame: m.startFrame,
          endFrame: m.endFrame,
          buffer: new Float32Array(length),
          filled: 0, // how many samples of the buffer are already captured
        };
      } else if (m.type === "trim") {
        const job = this.job;
        if (job && job.id === m.id) {
          const newEnd = Math.max(job.startFrame, Math.min(job.endFrame, m.endFrame));
          // Anything already copied beyond the new end is thrown away (set to silence).
          job.buffer.fill(0, newEnd - job.startFrame);
          job.endFrame = newEnd;
        }
      } else if (m.type === "peek") {
        const job = this.job;
        if (job && job.id === m.id) {
          const n = Math.max(0, Math.min(job.buffer.length, job.filled));
          this.port.postMessage({ type: "peek", id: job.id, data: job.buffer.slice(0, n) });
        }
      } else if (m.type === "cancel") {
        if (this.job && this.job.id === m.id) this.job = null;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const size = channel ? channel.length : 128;
    const blockStart = currentFrame; // absolute frame number of the first sample in this block
    const blockEnd = blockStart + size;

    // Loudness meter.
    if (channel) {
      for (let i = 0; i < size; i++) {
        const v = Math.abs(channel[i]);
        if (v > this.peak) this.peak = v;
      }
    }
    if (++this.blocks >= 12) {
      this.port.postMessage({ type: "level", peak: this.peak });
      this.peak = 0;
      this.blocks = 0;
    }

    // Recording: copy the part of this block that falls inside [startFrame, endFrame).
    const job = this.job;
    if (job) {
      const from = Math.max(blockStart, job.startFrame);
      const to = Math.min(blockEnd, job.endFrame);
      if (channel && to > from) {
        for (let f = from; f < to; f++) job.buffer[f - job.startFrame] = channel[f - blockStart];
      }
      job.filled = Math.max(job.filled, Math.min(blockEnd, job.endFrame) - job.startFrame);
      if (blockEnd >= job.endFrame) {
        this.port.postMessage({ type: "done", id: job.id, data: job.buffer }, [job.buffer.buffer]);
        this.job = null;
      }
    }
    return true; // keep running
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
