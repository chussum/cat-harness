import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { LanguageProvider } from '@/shared/i18n/LanguageProvider'

export default function App() {
  return (
    <LanguageProvider>
      <DashboardPage />
    </LanguageProvider>
  )
}
/* drift-test */
