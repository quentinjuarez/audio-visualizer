const DEFAULT_URL = import.meta.env.VITE_AUDIO_WS_URL || "ws://localhost:3000";

/**
 * Connects to the audio listener WebSocket server, parses incoming JSON frames
 * and dispatches them to a callback. Auto-reconnects on disconnect.
 */
export class WsClient {
  /** @param {{ onFrame: (frame: object) => void, onStatus: (connected: boolean) => void }} opts */
  constructor({ onFrame, onStatus }) {
    this._onFrame = onFrame;
    this._onStatus = onStatus;
    this._ws = null;
    this.connected = false;
    this._connect();
  }

  _connect() {
    this._ws = new WebSocket(DEFAULT_URL);

    this._ws.onopen = () => {
      this.connected = true;
      this._onStatus(true);
    };

    this._ws.binaryType = "arraybuffer";

    this._ws.onmessage = (event) => {
      try {
        const text =
          event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : event.data;
        this._onFrame(JSON.parse(text));
      } catch {
        // ignore malformed frames
      }
    };

    this._ws.onclose = () => {
      this.connected = false;
      this._onStatus(false);
      setTimeout(() => this._connect(), 2000);
    };

    this._ws.onerror = () => this._ws.close();
  }
}
