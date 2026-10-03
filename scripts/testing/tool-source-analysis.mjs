import ts from 'typescript';
/** Extract actual declared objects independent of composition location/quote style. */
export function extractToolDeclarations(text,file='tools.ts') {
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.ESNext,true,ts.ScriptKind.TS);const output=[];
 const visit=node=>{
  if(ts.isObjectLiteralExpression(node)){
   const fields=new Map(node.properties.filter(ts.isPropertyAssignment).map(property=>[property.name.getText(source).replace(/^['"]|['"]$/g,''),property.initializer]));
   const name=fields.get('name'),permission=fields.get('permissionLevel')??fields.get('permission'),run=fields.get('run');
   if(name&&ts.isStringLiteral(name)&&permission&&ts.isStringLiteral(permission)&&run){
    const calls=[];const collect=child=>{if(ts.isCallExpression(child)){const expression=child.expression;calls.push(expression.getText(source));if(ts.isPropertyAccessExpression(expression))calls.push(expression.name.text);}ts.forEachChild(child,collect);};collect(run);
    output.push({name:name.text,permission:permission.text,body:run.getText(source),calls:[...new Set(calls)],file});
   }
  }
  ts.forEachChild(node,visit);
 };visit(source);return output;
}

/** Named facade bodies can be checked without trusting comments or strings. */
export function extractFunctionDeclarations(text,file='functions.ts') {
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.ESNext,true,ts.ScriptKind.TS);
 return source.statements.filter(ts.isFunctionDeclaration).filter(node=>node.name&&node.body).map(node=>{
  const calls=[];
  const collect=child=>{if(ts.isCallExpression(child)){const expression=child.expression;calls.push(expression.getText(source));if(ts.isPropertyAccessExpression(expression))calls.push(expression.name.text);}ts.forEachChild(child,collect);};collect(node.body);
  return {name:node.name.text,calls:[...new Set(calls)]};
 });
}
