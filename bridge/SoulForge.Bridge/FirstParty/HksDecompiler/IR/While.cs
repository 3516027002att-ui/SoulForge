using System;
using SoulForge.Bridge.FirstParty.HksDecompiler.CFG;

namespace SoulForge.Bridge.FirstParty.HksDecompiler.IR
{
    public class While : Instruction
    {
        public required Expression Condition;

        public required BasicBlock Body;
        public BasicBlock? Follow = null;

        public bool IsPostTested = false;
        public bool IsBlockInlined = false;
        
        public override bool MatchAny(Func<IIrNode, bool> condition)
        {
            var result = condition.Invoke(this);
            result = result || Condition.MatchAny(condition);
            return result;
        }
    }
}


