local function choose(a, b)
    if a > b then
        return a + b
    end
    return b - a
end

return choose(7, 3)
