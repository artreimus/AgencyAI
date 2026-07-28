declare module "virtual:product-app-entry" {
  import type { ComponentType, ReactNode } from "react";

  export type ProductAppComposition = {
    Providers: ComponentType<{ children: ReactNode }>;
    Root: ComponentType;
  };

  export function loadProductApp(
    root: HTMLElement,
  ): Promise<ProductAppComposition>;
}
