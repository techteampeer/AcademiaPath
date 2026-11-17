import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { CartridgeInspectionView } from '@/components/cartridge/CartridgeInspectionView';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('cartridgeInspection');
}

export default async function CartridgeInspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CartridgeInspectionView courseId={id} />;
}
