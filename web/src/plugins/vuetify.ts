import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg'
import { zhHans } from 'vuetify/locale'
import { appTheme } from '../theme'

export default createVuetify({
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: { mdi },
  },
  locale: {
    locale: 'zhHans',
    messages: { zhHans },
  },
  theme: {
    defaultTheme: 'light',
    themes: {
      light: {
        dark: false,
        colors: {
          primary: appTheme.color.primary,
          secondary: appTheme.color.secondary,
          background: appTheme.color.canvas,
          surface: appTheme.color.surface,
          success: appTheme.color.success,
          warning: appTheme.color.warning,
          error: appTheme.color.error,
          info: appTheme.color.info,
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: 'md', variant: 'outlined', size: 'default', density: 'default', height: appTheme.control.height },
    VTextField: { variant: 'outlined', density: 'compact', hideDetails: 'auto', color: 'primary' },
    VTextarea: { variant: 'outlined', density: 'compact', hideDetails: 'auto', color: 'primary' },
    VSelect: { variant: 'outlined', density: 'compact', hideDetails: 'auto', color: 'primary' },
    VFileInput: { variant: 'outlined', density: 'compact', hideDetails: 'auto', color: 'primary' },
    VChip: { size: 'small', variant: 'tonal' },
    VAlert: { variant: 'tonal', density: 'comfortable', icon: false },
  },
})
