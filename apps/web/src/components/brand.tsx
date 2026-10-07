import { BrandLockup } from "@avgeek-oss/design-system/media/brand-lockup";

export function Brand() {
  return (
    <BrandLockup
      logo={<img src="/brand/vitalog-mark.png" alt="" width={32} height={32} />}
    >
      Vitalog
    </BrandLockup>
  );
}
