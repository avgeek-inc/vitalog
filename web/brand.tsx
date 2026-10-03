import brandMark from "./assets/vitalog-mark.png";

export function Brand() {
  return (
    <div className="brand">
      <img src={brandMark} alt="" width={48} height={48} />
      <span>Vitalog</span>
    </div>
  );
}
