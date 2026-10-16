import fs from 'fs';

const filePaths = [
  'prisma/migrations/20260529161300_initial_enterprise_schema_and_sync/migration.sql',
  'workspace/prisma/migrations/20260529161300_initial_enterprise_schema_and_sync/migration.sql',
  'app/applet/prisma/migrations/20260529161300_initial_enterprise_schema_and_sync/migration.sql'
];

filePaths.forEach(filePath => {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  let lines = content.split('\n');
  
  const beforeAfter = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim().startsWith('-- CreateIndex:') && l.includes('ON')) {
      const orig = l;
      const commentPart = l.replace('-- CreateIndex:', '').trim();
      const match = commentPart.match(/^(.+?)\s+ON\s+(.+)$/);
      if (match) {
        const indexName = match[1].replace(/"/g, '').trim();
        const rest = match[2].trim();
        
        const newCommentLine = `-- CreateIndex: ${indexName}`;
        const newSqlLine = `CREATE INDEX "${indexName}" ON ${rest}`;
        
        beforeAfter.push({ line: i + 1, before: orig, afterComment: newCommentLine, afterSql: newSqlLine });
        
        lines[i] = `${newCommentLine}\n${newSqlLine}`;
      }
    }
  }

  const updatedContent = lines.join('\n');
  fs.writeFileSync(filePath, updatedContent, 'utf8');
  console.log(`Updated ${filePath}, fixed ${beforeAfter.length} indexes.`);
  if (filePath === filePaths[0]) {
    console.log('BEFORE/AFTER LIST:');
    beforeAfter.forEach(item => {
      console.log(`Line ${item.line}:`);
      console.log(`  BEFORE: ${item.before}`);
      console.log(`  AFTER:  ${item.afterComment}`);
      console.log(`          ${item.afterSql}`);
    });
  }
});
