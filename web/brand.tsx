import brandMark from "./assets/vitalog-mark.png";

export function Brand() {
  return (
    <div className="brand">
      <img src={brandMark} alt="Vitalog" width={64} height={64} />
    </div>
  );
}
