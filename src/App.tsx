import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "./board/Canvas";
import "./App.css";

/** The open board. Loading it is done before render (src/files/boot.tsx). */
export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
