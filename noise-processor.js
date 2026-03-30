class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.type = 'brown';
    // Brown noise state
    this.lastOut = 0;
    // Pink noise state (Voss-McCartney)
    this.pinkRows = new Float64Array(6);
    this.pinkRunningSum = 0;
    this.pinkCounter = 0;
    for (let i = 0; i < 6; i++) {
      const val = Math.random() * 2 - 1;
      this.pinkRows[i] = val;
      this.pinkRunningSum += val;
    }

    this.port.onmessage = (e) => {
      if (e.data.type) {
        this.type = e.data.type;
        // Reset state on type change
        this.lastOut = 0;
        this.pinkCounter = 0;
        this.pinkRunningSum = 0;
        for (let i = 0; i < 6; i++) {
          const val = Math.random() * 2 - 1;
          this.pinkRows[i] = val;
          this.pinkRunningSum += val;
        }
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const channel = output[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      channel[i] = this.generateSample();
    }
    return true;
  }

  generateSample() {
    switch (this.type) {
      case 'white': return this.white();
      case 'pink': return this.pink();
      case 'brown': return this.brown();
      default: return 0;
    }
  }

  white() {
    return Math.random() * 2 - 1;
  }

  pink() {
    const numRows = 6;
    const counter = this.pinkCounter++;

    // Determine which row to update based on trailing zeros
    let row = 0;
    let n = counter;
    while (row < numRows - 1 && (n & 1) === 0) {
      row++;
      n >>= 1;
    }

    // Update that row
    this.pinkRunningSum -= this.pinkRows[row];
    const newVal = Math.random() * 2 - 1;
    this.pinkRows[row] = newVal;
    this.pinkRunningSum += newVal;

    // Normalize: sum of numRows random values, scale to [-1, 1]
    return this.pinkRunningSum / numRows;
  }

  brown() {
    const white = Math.random() * 2 - 1;
    this.lastOut = (this.lastOut + 0.02 * white) / 1.02;
    return this.lastOut * 3.5;
  }
}

registerProcessor('noise-generator', NoiseProcessor);
