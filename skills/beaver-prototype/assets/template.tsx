// Seed template for the beaver-prototype skill. Always start from here.
//
// Rules — see SKILL.md for the full list:
//   1. Imports only from @beaver-ui/*, @tui-react/components,
//      @tui-react/design-tokens, react, react-dom.
//   2. Components and props only from skills/beaver-prototype/components.json.
//   3. No raw HTML tags. No hardcoded colors / sizes / fonts.
//   4. Single file, single default export named `Prototype`.

import { Layout } from '@beaver-ui/layout';
import { Header } from '@beaver-ui/header';
import { Box } from '@beaver-ui/box';

export default function Prototype() {
  return (
    <Layout>
      <Header />
      <Box>{/* TODO: compose screen here */}</Box>
    </Layout>
  );
}
